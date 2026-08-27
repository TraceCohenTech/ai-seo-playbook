# Setting Up Google Search Console API Access

This guide walks you through creating API credentials to use with the scripts in this repo.

## Prerequisites

- A Google account with access to your site in [Google Search Console](https://search.google.com/search-console)
- A Google Cloud project (free tier is fine)

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click **Select a project** → **New Project**
3. Name it something like `seo-toolkit`
4. Click **Create**

## Step 2: Enable the Search Console API

1. In your project, go to **APIs & Services** → **Library**
2. Search for "Google Search Console API"
3. Click **Enable**

Also enable the **Web Search Indexing API** if you want URL inspection features.

## Step 3: Set Up Authentication

### Option A: Application Default Credentials (for local use)

This is the simplest option for running scripts on your own machine.

```bash
# Install the Google Cloud CLI if you haven't
brew install google-cloud-sdk  # macOS
# or visit https://cloud.google.com/sdk/docs/install

# Log in and set up credentials
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform

# This creates a credentials file at:
# ~/.config/gcloud/application_default_credentials.json
# The googleapis library picks it up automatically
```

### Option B: Service Account (for CI/CD and automation)

Use this for GitHub Actions, cron jobs, or any automated workflow.

1. Go to **IAM & Admin** → **Service Accounts**
2. Click **Create Service Account**
3. Name it `seo-report-bot`
4. Click **Create and Continue**
5. Skip the optional permissions steps
6. Click **Done**
7. Click on the new service account → **Keys** → **Add Key** → **Create New Key**
8. Choose **JSON** → **Download**

Now add the service account to Search Console:

1. Go to [Search Console](https://search.google.com/search-console)
2. Select your property
3. Click **Settings** → **Users and permissions**
4. Click **Add User**
5. Enter the service account email (looks like `seo-report-bot@your-project.iam.gserviceaccount.com`)
6. Set permission to **Full** (or **Restricted** for read-only)
7. Click **Add**

For GitHub Actions, add the JSON key as a secret:

```bash
# In your repo settings → Secrets → New secret
# Name: GSC_CREDENTIALS
# Value: paste the entire JSON key file contents
```

## Step 4: Find Your Site Property

Your GSC site property is either:
- **Domain property**: `sc-domain:example.com` (covers all subdomains and protocols)
- **URL prefix**: `https://www.example.com/` (exact prefix match)

Domain properties are preferred — they aggregate all variations.

Check which one you have in the Search Console sidebar.

## Step 5: Test It

```bash
# Clone the repo and install dependencies
git clone https://github.com/TraceCohenTech/ai-seo-playbook.git
cd ai-seo-playbook
npm install

# Run the weekly report to verify everything works
node scripts/weekly-report.mjs --site sc-domain:yoursite.com

# You should see a summary with clicks, impressions, and top pages
```

## Troubleshooting

**"User does not have sufficient permissions"**
- Make sure your Google account (or service account) is added as a user in Search Console with at least Restricted access.

**"API has not been enabled"**
- Go to APIs & Services → Library and enable "Google Search Console API"

**"Could not load the default credentials"**
- Run `gcloud auth application-default login` again
- Or set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`

**"Quota exceeded"**
- The free tier allows 1,200 queries per day. The scripts in this repo are well within that limit for most sites. If you have thousands of pages, the weekly report may need to be batched.

## Data Freshness

GSC data has a 2-3 day delay. When you run a report on Monday, the most recent data is from Friday or Saturday. This is normal — Google processes data in batches.

The `--days` flag on most scripts defaults to 28 (the standard SEO reporting window). For trend detection, the weekly report compares the current 7 days against the previous 7 days and the 3-week average.
