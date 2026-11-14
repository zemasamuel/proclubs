// Vercel serverless function: triggers the GitHub Actions fetch workflow.
// Called by Vercel Cron on a schedule defined in vercel.json.
module.exports = async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  }

  const response = await fetch(
    'https://api.github.com/repos/zemasamuel/proclubs/actions/workflows/fetch.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (response.status === 204) {
    return res.status(200).json({ ok: true, triggered: new Date().toISOString() });
  }

  const text = await response.text();
  return res.status(response.status).json({ error: text });
};