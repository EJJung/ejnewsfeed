import { useNavigate } from 'react-router-dom'

export default function PrivacyPage() {
  const navigate = useNavigate()

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 min-h-full">
      <div className="max-w-2xl mx-auto px-6 py-10">

        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-8 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <h1 className="text-2xl font-bold text-gray-900 mb-1">Privacy Policy</h1>
        <p className="text-sm text-gray-400 mb-8">Last updated: May 2025</p>

        <div className="space-y-8 text-sm text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">1. Overview</h2>
            <p>
              EJ Newsfeed is a personal news aggregation tool that processes your Gmail newsletters
              and surfaces them in a clean, readable digest. This Privacy Policy explains what data
              is collected, how it is used, and what controls you have over it.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">2. Data We Collect</h2>
            <p className="mb-2">
              EJ Newsfeed accesses your Gmail account via OAuth to read newsletter emails. Specifically,
              we collect:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Email subject lines, sender addresses, and body content of newsletters</li>
              <li>Timestamps and metadata associated with those emails</li>
              <li>Articles you save or interact with within the app</li>
            </ul>
            <p className="mt-2">
              We do not collect personal emails, contacts, attachments, or any email not identified as
              a newsletter.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">3. How We Use Your Data</h2>
            <p className="mb-2">Collected data is used solely to:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Parse and display newsletter content in the feed</li>
              <li>Generate AI-powered summaries and trend analysis</li>
              <li>Persist saved articles and preferences across sessions</li>
            </ul>
            <p className="mt-2">
              Your data is never sold, shared with third parties, or used for advertising purposes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">4. Data Storage</h2>
            <p>
              Processed article data is stored in a Supabase database. Raw email content is not
              persisted — only extracted article metadata (title, summary, source, date) is stored.
              Data is retained for up to 90 days, after which older records are automatically pruned.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">5. Third-Party Services</h2>
            <p className="mb-2">EJ Newsfeed uses the following third-party services:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li><strong>Google Gmail API</strong> — to read newsletter emails via OAuth</li>
              <li><strong>Supabase</strong> — for database storage and authentication</li>
              <li><strong>Anthropic Claude API</strong> — to generate article summaries and trend analysis</li>
            </ul>
            <p className="mt-2">
              Each of these services has their own privacy policies which govern how they process data.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">6. Your Rights</h2>
            <p>
              You may revoke Gmail access at any time via your{' '}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-600 hover:underline"
              >
                Google Account permissions
              </a>
              . To request deletion of your stored data, contact us directly.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 mb-2">7. Contact</h2>
            <p>
              Questions about this policy can be directed to{' '}
              <a href="mailto:euijjung@umich.edu" className="text-violet-600 hover:underline">
                euijjung@umich.edu
              </a>.
            </p>
          </section>

        </div>
      </div>
    </div>
  )
}
