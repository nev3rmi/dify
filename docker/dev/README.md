# Dify Development Environment with Hot Reload

This setup provides a fully containerized development environment for Dify with hot reload support for both the backend (Flask/Python) and frontend (Next.js).

## Features

- **API (Flask)**: Auto-reloads on Python code changes using Flask debug mode
- **Web (Next.js)**: Fast refresh with Turbopack on frontend changes
- **Worker (Celery)**: Optional hot reload using watchfiles
- **Full stack**: All services (PostgreSQL, Redis, Weaviate, etc.) included

## Quick Start

### 1. Setup Environment

```bash
cd docker

# Copy the example environment file
cp .env.dev.example .env.dev

# (Optional) Customize .env.dev if needed
```

### 2. Start Development Environment

```bash
# Start all services
docker compose -f docker-compose.dev.yaml --env-file .env.dev up -d

# Or start with logs visible
docker compose -f docker-compose.dev.yaml --env-file .env.dev up
```

### 3. Access Services

- **Web UI**: http://localhost:3000
- **API**: http://localhost:5001
- **PostgreSQL**: localhost:5432
- **Redis**: localhost:6379
- **Weaviate**: localhost:8080

### 4. View Logs

```bash
# All services
docker compose -f docker-compose.dev.yaml --env-file .env.dev logs -f

# Specific service
docker compose -f docker-compose.dev.yaml --env-file .env.dev logs -f api
docker compose -f docker-compose.dev.yaml --env-file .env.dev logs -f web
docker compose -f docker-compose.dev.yaml --env-file .env.dev logs -f worker
```

### 5. Stop Environment

```bash
docker compose -f docker-compose.dev.yaml --env-file .env.dev down

# To also remove volumes (database data, etc.)
docker compose -f docker-compose.dev.yaml --env-file .env.dev down -v
```

## Hot Reload Details

### Backend (API)

The Flask server runs in debug mode, which automatically:
- Detects changes to `.py` files in the `/api` directory
- Reloads the server when changes are detected
- Displays detailed error messages and stack traces

### Frontend (Web)

Next.js runs with:
- Turbopack for fast compilation
- Fast Refresh for instant UI updates
- Full HMR (Hot Module Replacement) support

Changes to React components, styles, and other frontend files are reflected immediately without full page reload.

### Celery Worker

The worker service can be configured with `watchfiles` for hot reload:
- Set `WATCHFILES_ENABLED=true` in `.env.dev`
- Worker will restart when Python files change

Note: For most development, you may not need worker hot reload as task code changes are picked up when tasks are executed.

## Rebuilding Images

If you modify the Dockerfiles or need to update dependencies:

```bash
# Rebuild all images
docker compose -f docker-compose.dev.yaml --env-file .env.dev build

# Rebuild specific service
docker compose -f docker-compose.dev.yaml --env-file .env.dev build api
docker compose -f docker-compose.dev.yaml --env-file .env.dev build web

# Force rebuild without cache
docker compose -f docker-compose.dev.yaml --env-file .env.dev build --no-cache
```

## Volume Mounts

The development setup mounts your source code directly:

| Host Path | Container Path | Service |
|-----------|----------------|---------|
| `../api` | `/app/api` | api, worker, worker_beat |
| `../web` | `/app/web` | web |
| `./volumes/db/data` | `/var/lib/postgresql/data` | db_postgres |
| `./volumes/redis/data` | `/data` | redis |
| `./volumes/weaviate` | `/var/lib/weaviate` | weaviate |
| `./volumes/app/storage` | `/app/api/storage` | api, worker |

## Troubleshooting

### Port Already in Use

If ports are already in use, modify them in `.env.dev`:

```bash
API_PORT=5002
WEB_PORT=3001
DB_PORT_EXPOSED=5433
```

### Database Migration Issues

Run migrations manually:

```bash
docker compose -f docker-compose.dev.yaml --env-file .env.dev exec api flask upgrade-db
```

### Node Modules Issues

If you encounter frontend build issues:

```bash
# Remove the web container and its volumes
docker compose -f docker-compose.dev.yaml --env-file .env.dev rm -f -v web

# Rebuild the web service
docker compose -f docker-compose.dev.yaml --env-file .env.dev up -d --build web
```

### Hot Reload Not Working

For the API:
- Ensure `DEBUG=true` is set
- Check that Flask debug mode is active in logs

For the Web:
- Ensure `WATCHPACK_POLLING=true` is set (required for Docker on some systems)
- Check browser console for HMR connection errors

### WSL2 Performance

If running on WSL2 and experiencing slow file syncing:
- Ensure your project is in the Linux filesystem (not `/mnt/c/`)
- The `WATCHPACK_POLLING=true` and `CHOKIDAR_USEPOLLING=true` settings help with file watching

## Services Overview

| Service | Description | Port |
|---------|-------------|------|
| `api` | Flask API server with debug mode | 5001 |
| `worker` | Celery background worker | - |
| `worker_beat` | Celery scheduler | - |
| `web` | Next.js dev server | 3000 |
| `db_postgres` | PostgreSQL database | 5432 |
| `redis` | Redis cache/broker | 6379 |
| `weaviate` | Vector database | 8080 |
| `sandbox` | Code execution sandbox | 8194 |
| `plugin_daemon` | Plugin management | 5002, 5003 |
| `ssrf_proxy` | Security proxy | 3128 |
