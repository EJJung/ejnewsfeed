"""
gmail_fetch.py
==============
Connects to ej.newsfeed@gmail.com via Gmail API and fetches unprocessed
newsletter emails. Saves raw email records to Supabase.

Run once to authorize: python gmail_fetch.py --auth
Then run daily (or via scheduled task): python gmail_fetch.py
"""

import os
import base64
import json
import argparse
from datetime import datetime, timezone
from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from supabase import create_client

load_dotenv()

SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

SUPABASE_URL  = os.environ['SUPABASE_URL']
SUPABASE_KEY  = os.environ['SUPABASE_SERVICE_ROLE_KEY']
TOKEN_PATH    = os.environ.get('GMAIL_TOKEN_PATH', './gmail_token.json')
CLIENT_ID     = os.environ['GMAIL_CLIENT_ID']
CLIENT_SECRET = os.environ['GMAIL_CLIENT_SECRET']


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_gmail_service():
    creds = None

    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            # Build a minimal client config dict from env vars
            client_config = {
                "installed": {
                    "client_id": CLIENT_ID,
                    "client_secret": CLIENT_SECRET,
                    "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"],
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                }
            }
            flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_PATH, 'w') as f:
            f.write(creds.to_json())

    return build('gmail', 'v1', credentials=creds)


# ── Email parsing ─────────────────────────────────────────────────────────────

def decode_body(part):
    """Decode a Gmail message part body."""
    data = part.get('body', {}).get('data', '')
    if data:
        return base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
    return ''


def extract_email_content(message):
    """Extract HTML and plain text from a Gmail message payload."""
    payload = message.get('payload', {})
    html_content  = ''
    text_content  = ''

    def walk_parts(parts):
        nonlocal html_content, text_content
        for part in parts:
            mime = part.get('mimeType', '')
            if mime == 'text/html':
                html_content = decode_body(part)
            elif mime == 'text/plain':
                text_content = decode_body(part)
            elif 'parts' in part:
                walk_parts(part['parts'])

    if 'parts' in payload:
        walk_parts(payload['parts'])
    else:
        mime = payload.get('mimeType', '')
        if mime == 'text/html':
            html_content = decode_body(payload)
        elif mime == 'text/plain':
            text_content = decode_body(payload)

    return html_content, text_content


def parse_headers(message):
    headers = {h['name'].lower(): h['value'] for h in message.get('payload', {}).get('headers', [])}
    return headers


# ── Main fetch ────────────────────────────────────────────────────────────────

def fetch_new_emails(service, supabase_client, max_results=50):
    """Fetch unread emails and store them as raw_emails in Supabase."""

    print(f"Fetching up to {max_results} unread emails from inbox...")

    result = service.users().messages().list(
        userId='me',
        labelIds=['INBOX', 'UNREAD'],
        maxResults=max_results,
    ).execute()

    messages = result.get('messages', [])
    print(f"Found {len(messages)} unread messages.")

    saved_count = 0

    for msg_meta in messages:
        msg_id = msg_meta['id']

        # Skip if already in Supabase
        existing = supabase_client.table('raw_emails') \
            .select('id') \
            .eq('gmail_message_id', msg_id) \
            .execute()

        if existing.data:
            continue

        # Fetch full message
        message = service.users().messages().get(
            userId='me', id=msg_id, format='full'
        ).execute()

        headers      = parse_headers(message)
        html_body, text_body = extract_email_content(message)
        sender       = headers.get('from', '')
        subject      = headers.get('subject', '(no subject)')
        date_str     = headers.get('date', '')

        # Parse received timestamp
        try:
            from email.utils import parsedate_to_datetime
            received_at = parsedate_to_datetime(date_str).isoformat()
        except Exception:
            received_at = datetime.now(timezone.utc).isoformat()

        # Look up or create source
        sender_email = sender.split('<')[-1].rstrip('>').strip().lower() if '<' in sender else sender.strip().lower()
        source_result = supabase_client.table('sources') \
            .select('id') \
            .eq('email_address', sender_email) \
            .execute()

        if source_result.data:
            source_id = source_result.data[0]['id']
        else:
            # Auto-create source from sender
            sender_name = sender.split('<')[0].strip().strip('"') if '<' in sender else sender_email
            new_source = supabase_client.table('sources').insert({
                'name': sender_name,
                'email_address': sender_email,
            }).execute()
            source_id = new_source.data[0]['id'] if new_source.data else None

        # Insert raw email
        supabase_client.table('raw_emails').insert({
            'gmail_message_id': msg_id,
            'source_id': source_id,
            'subject': subject,
            'sender': sender,
            'received_at': received_at,
            'raw_html': html_body or None,
            'raw_text': text_body or None,
            'processed': False,
        }).execute()

        saved_count += 1
        print(f"  ✓ Saved: {subject[:60]}")

    print(f"\nDone. {saved_count} new emails saved to Supabase.")
    return saved_count


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--auth', action='store_true', help='Run OAuth flow to authorize Gmail access')
    args = parser.parse_args()

    service = get_gmail_service()

    if args.auth:
        print("Authorization successful! Token saved to", TOKEN_PATH)
    else:
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)
        fetch_new_emails(service, sb)
