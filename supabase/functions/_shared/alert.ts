/**
 * Shared alert helper — posts a best-effort webhook notification when a
 * pipeline job fails. Used by any Edge Function job that wants to alert on
 * fatal errors (currently distill-insights; process-emails keeps its own
 * local copy for now).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export async function sendAlert(
  supabase: ReturnType<typeof createClient>,
  jobName: string,
  message: string,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('_pipeline_config')
      .select('value')
      .eq('key', 'alert_webhook_url')
      .maybeSingle()
    const url = (data as { value?: string } | null)?.value?.trim()
    if (!url) return
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '🚨 EJ Newsfeed Pipeline Error',
        message,
        job: jobName,
        timestamp: new Date().toISOString(),
      }),
    })
  } catch { /* best-effort */ }
}
