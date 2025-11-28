# Custom WebApp UI Development

This branch (`custom-webapp-ui`) contains customizations to Dify's Run App (published webapp) frontend.

## Architecture

```
Your WSL (192.168.31.174)
├── Full Dify source code          ← This repo
├── FE dev server (localhost:3000) ← Hot reload enabled
│   └── Connects to →
│
Production (192.168.31.98)
└── Backend Docker                 ← Production data
```

## Development Workflow

### 1. Start Development Server
```bash
cd /home/nev3r/projects/dify/web
NEXT_PUBLIC_API_PREFIX=http://192.168.31.98/console/api \
NEXT_PUBLIC_PUBLIC_API_PREFIX=http://192.168.31.98/api \
pnpm dev
```

### 2. Access Run App for Testing
- Create/publish an app on production: http://192.168.31.98
- Get the share token
- Test on local dev: http://localhost:3000/chat/{token}
- Hot reload works - edit and save to see changes!

### 3. Make Your Changes

Edit files in:
```
web/app/(shareLayout)/          ← Run App pages
├── chat/[token]/page.tsx       ← Chat UI entry
├── workflow/[token]/page.tsx   ← Workflow UI entry
└── completion/[token]/page.tsx ← Completion UI entry

web/app/components/
├── base/chat/chat-with-history/  ← Main chat component
│   ├── header/                   ← Header
│   ├── sidebar/                  ← Conversation list
│   └── inputs-form/              ← Input area
├── base/chat/chat/               ← Core chat logic
│   ├── answer/                   ← AI response display
│   └── chat-input-area/          ← Input controls
└── share/text-generation/        ← Workflow/Completion UI
```

### 4. Commit Your Changes
```bash
# Commit each feature separately
git add web/app/(shareLayout)/chat/
git commit -m "feat: customize chat header"

git add web/app/components/base/chat/answer/
git commit -m "feat: improve message display"
```

## Keeping Up with Dify Updates

### When Dify Releases New Version

```bash
# 1. Fetch latest from Dify
git fetch origin main

# 2. Rebase your changes on top
git rebase origin/main

# 3. Resolve conflicts if any
# 4. Test your changes still work

# 5. Deploy to production (see below)
```

## Deploying to Production

### Option 1: Manual Copy (Simple)
```bash
# Copy your modified files to production
scp -r web/app/(shareLayout)/ ubuntu@192.168.31.98:~/dify/web/app/
scp -r web/app/components/ ubuntu@192.168.31.98:~/dify/web/app/

# Restart production web container
ssh ubuntu@192.168.31.98
cd ~/dify/docker
sudo docker compose restart web
```

### Option 2: Git-based Deployment
```bash
# On production server
ssh ubuntu@192.168.31.98
cd ~/dify
git remote add custom git@your-repo/dify-custom.git
git fetch custom
git checkout custom-webapp-ui
docker compose restart web
```

## File Organization

### Keep Separate (Git Ignored)
- `web/.env.local` - Local dev config
- `docker/.env.dev` - Local Docker config
- `docker/docker-compose.dev.yaml` - Dev compose
- `docker/dev/PLAN-*.md` - Planning docs
- `docker/dev/SETUP-*.md` - Setup guides

### Track in Git (Your Changes)
- `web/app/(shareLayout)/` - Run App pages
- `web/app/components/` - UI components
- `web/i18n/en-US/share.ts` - Translations
- `web/models/share.ts` - Types (if you add new ones)

## Current Setup

**Branch:** `custom-webapp-ui`
**Dev Server:** Running (shell `b3d38d`)
**Access:** http://localhost:3000/chat/B33cJRbBs4ljZuHN
**Hot Reload:** ✅ Enabled

## Next Steps

1. Make your first UI change (example below)
2. See it hot reload
3. Commit the change
4. Deploy to production when ready

### Example: Test Hot Reload

Edit `/home/nev3r/projects/dify/web/app/(shareLayout)/chat/[token]/page.tsx`:

```typescript
// Add a console log to test
console.log('🔥 Hot reload working!')
```

Save → Check browser console → Should see the log instantly!

---

Ready to start developing your custom Run App UI! 🚀
