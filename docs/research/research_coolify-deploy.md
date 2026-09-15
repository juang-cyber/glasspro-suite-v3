# Deploying a Node.js (Express + better-sqlite3, persistent /app/storage) app on self-hosted Coolify v4 via the Dockerfile build pack: UI steps, storage, env vars, health checks, auto-deploy, API, outbound IP

## 0. Prerequisites (server, DNS, firewall)

- **Open TCP ports on the VPS** (https://coolify.io/docs/knowledge-base/server/firewall): `22` (SSH), `80` (HTTP + Let's Encrypt HTTP-01 challenge), `443` (HTTPS). `8000`, `6001`, `6002` are only for reaching the Coolify dashboard by raw IP; you can close them once the dashboard has its own domain through the proxy. Docker punches through `ufw`, so prefer the hosting provider's firewall.
- **DNS** (https://coolify.io/docs/knowledge-base/dns-configuration, https://coolify.io/docs/knowledge-base/domains): create an **A record** `suite.glasspro.co.id -> <VPS public IPv4>`. Only add an AAAA record if IPv6 really works on the server, and if you do, both must point at the same box. Verify with `dig +short suite.glasspro.co.id` before entering the domain in Coolify. If DNS changed recently, wait for the old TTL to expire.
- **Cloudflare**: if the record is orange-cloud proxied, HTTP-01 validation can fail (https://coolify.io/docs/troubleshoot/dns-and-domains/lets-encrypt-not-working). Simplest: set the record to "DNS only" (grey cloud), at least until the certificate is issued. Alternative: switch Traefik to DNS challenge (https://coolify.io/docs/knowledge-base/proxy/traefik/dns-challenge).
- **Proxy must be running**: `Servers -> <server> -> Proxy` (Traefik is the default; Caddy is selectable there). Proxy files live in `/data/coolify/proxy/` (Traefik: `docker-compose.yml`, `dynamic/`, `acme.json`).

## 1. Creating the Application (Dockerfile build pack)

Docs: https://coolify.io/docs/applications/build-packs/dockerfile, https://coolify.io/docs/applications/configuration/general, https://coolify.io/docs/knowledge-base/domains

### 1a. Choose a source

**Public repo** (https://coolify.io/docs/knowledge-base/git/github/integration):
1. Sidebar `Projects` -> open project -> open environment (e.g. `production`).
2. Click **`+ New`** (some doc pages call it "Create New Resource" / "Add Resource" - same button; label varies slightly by version).
3. Pick **`Public Repository`**, select the **server** (and destination = the `coolify` Docker network), paste the HTTPS URL `https://github.com/<owner>/<repo>`, click **`Check Repository`**, choose the **branch**.

**Private repo via GitHub App** (recommended; gives push-to-deploy with no manual webhook) (https://coolify.io/docs/applications/sources/github/app):
1. Sidebar **`Sources`** -> **`+ Add`** -> name it (e.g. "GitHub App") -> enter the GitHub **organization** name or leave blank for a personal account -> **`Continue`**.
2. Choose **`Automated Installation`**; the **webhook endpoint** must be the public base URL of your Coolify dashboard, e.g. `https://coolify.example.com` (GitHub must be able to reach it). Leave **`Preview Deployments`** on if you want PR previews. Click **`Register Now`**.
3. On GitHub's manifest page enter a unique app name -> **`Create GitHub App`** -> GitHub redirects back to Coolify.
4. Click **`Install Repositories on GitHub`** -> choose "All repositories" or "Only select repositories" -> install.
   Permissions granted: read contents + metadata, email, read/write pull requests (if previews), webhooks.
5. In the project/environment: **`+ New`** -> **`Private Repository (with GitHub App)`** -> select server -> select the source -> **Load Repository** -> choose branch.

**Private repo via Deploy Key** (https://coolify.io/docs/applications/sources/github/deploy-key):
1. Sidebar **`Keys & Tokens`** -> **`Private Keys`** -> **`+ Add`** -> **`Generate new ED25519 SSH Key`** (or RSA) -> copy the **public key** -> **`Continue`**.
2. GitHub repo -> `Settings -> Deploy keys -> Add deploy key` -> paste public key, title, leave "Allow write access" OFF -> save.
3. Copy the SSH URL from GitHub (`Code -> Local -> SSH`): `git@github.com:OWNER/REPO.git`.
4. **`+ New`** -> **`Private Repository (with Deploy Key)`** -> server -> pick the private key -> paste SSH URL -> branch.
   Note: deploy-key apps do NOT get push-to-deploy automatically; you must add a manual webhook (section 5).

### 1b. Build settings (General tab, `Configuration -> General`)
- **`Build Pack`**: `Dockerfile`.
- **`Base Directory`**: the repo folder Docker uses as build context. `/` for repo root (monorepo: e.g. `/apps/api`).
- **`Dockerfile Location`**: path **relative to Base Directory**, default `/Dockerfile`. So with the Dockerfile at the repo root, keep Base Directory `/` and Dockerfile Location `/Dockerfile`. Docs: "The path formed by Base Directory and Dockerfile Location".
- **`Ports Exposes`**: the port the process listens on **inside the container** (Coolify pre-fills `3000`; change it if your app uses another port). "The first port will be the default port for health checks." The docs stress: "The process must listen on `0.0.0.0`, not only `127.0.0.1`, for the Coolify proxy to reach it." In Express: `app.listen(process.env.PORT || 3000, '0.0.0.0')`.
- **`Ports Mappings`** (`host:container`): LEAVE EMPTY. A host port binding bypasses the proxy and also disables rolling updates (https://coolify.io/docs/knowledge-base/rolling-updates).
- **`Docker Build Stage Target`**, **`Custom Docker Options`**, **`Network Aliases`**, **`Pre/Post-deployment command`**: optional.
- **`Domains`**: full URL(s) **with scheme**, comma-separated: `https://suite.glasspro.co.id`. Coolify pre-fills a temporary `sslip.io` domain if none is set - replace it. Optional forms: `https://host:3000` (route to a specific container port; only needed for multi-port apps), `https://host/api` (path routing; prefix is stripped unless you turn off **`Strip Prefixes`** in Advanced). Do not reuse the same domain on two resources.
- **`Direction`**: `Allow www & non-www` / `Redirect to www` / `Redirect to non-www` (only relevant if you also add `https://www...` to Domains with its own DNS record).
- **`Configuration -> Advanced`**: **`Force HTTPS`** (default on; HTTP -> HTTPS redirect), **`Inject Build Args to Dockerfile`** (default on; see section 3), **`Auto Deploy`** (see section 5).
- Click **`Deploy`**. Follow the build in **`Deployments`** -> open the running deployment.

### 1c. How the domain becomes HTTPS
- Coolify writes Traefik Docker labels on the container: router rule `Host(suite.glasspro.co.id)`, service port = Ports Exposes, TLS cert resolver `letsencrypt` (HTTP-01 challenge) (https://coolify.io/docs/knowledge-base/proxy/traefik/overview). The `coolify-proxy` container listens on 80/443 and forwards over the shared `coolify` Docker network to the container's internal port - the container itself publishes nothing on the host (https://coolify.io/docs/core/networking-in-coolify).
- Using `https://` in Domains triggers automatic Let's Encrypt issuance and renewal (90-day certs). Requirements: DNS already resolving to this server, ports 80 and 443 publicly reachable, no interfering CDN proxy.
- Caddy alternative (https://coolify.io/docs/knowledge-base/proxy/caddy/overview): `Servers -> <server> -> Proxy` -> switch type. Uses `lucaslorentz/caddy-docker-proxy`, automatic HTTPS, also listens 80/443 (+HTTP/3 UDP 443). Traefik and Caddy configs are not interchangeable; core team runs Traefik in production - stay on Traefik unless you have a reason.
- Cert troubleshooting: `Servers -> <server> -> Proxy -> Logs` (look for 429 rate-limit or 403 WAF errors); nuclear option `rm /data/coolify/proxy/acme.json` then restart the proxy.

## 2. Persistent storage for `/app/storage` (SQLite DB + generated PDFs)

Docs: https://coolify.io/docs/core/persistent-storage/storage-mounts/overview, https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts, https://coolify.io/docs/core/persistent-storage/storage-mounts/bind-mounts, https://coolify.io/docs/knowledge-base/persistent-storage

### 2a. UI steps (recommended: named Volume Mount)
1. Open the application -> **`Configuration -> Persistent Storage`** -> **`Add`** -> **`Volume Mount`**.
2. **`Name`**: e.g. `storage` (Coolify prefixes it with the resource UUID on the server, so the real Docker volume is `<app-uuid>-storage`).
3. **`Source Path`**: leave **empty** ("Entering a source path creates a bind mount instead of a named volume").
4. **`Destination Path`**: `/app/storage` (must be the exact directory your code writes to - "/app is common, but it is not a universal container base directory").
5. Click **`Add`**, then **Redeploy** (mounts only apply when the container is recreated).
6. Verify: write a file, redeploy again, confirm it is still there.

Other mount types: **`Directory Mount`** = bind mount to a host dir Coolify creates under `/data/coolify/applications/<uuid>/...` (removing it from the UI can DELETE the host data; back up first). **`File Mount`** = single Coolify-managed file - NOT suitable for SQLite (the `-wal`/`-shm` sidecar files must live next to the DB, so always mount the directory, never the `.db` file).

Guardrails from the docs: keep **`Delete Unused Volumes`** (server cleanup setting) disabled unless you have backed up every volume; persistent storage is not a backup - use the app's **`Backups`** page (scheduled storage backups exist for volume/directory mounts); storage is local to the one server and "multi-server applications cannot use persistent storage".

### 2b. Permission / ownership gotchas with `USER node` (uid 1000)
- Docs: "Docker does not translate file ownership between the server and the container" and "The container user must have permission to read and write the mounted destination." Bind mounts / directory mounts are created by Coolify as root (or as the SSH user on non-root servers - see https://github.com/coollabsio/coolify/issues/3440, where ownership even reverted after a manual `chown`). A container running as uid 1000 then gets `EACCES`/`SQLITE_CANTOPEN` on `/app/storage`.
- Named volumes: Docker itself creates the volume root-owned, BUT on the **first** mount of an **empty** named volume Docker copies the image's existing contents *and ownership* of the destination directory into the volume (standard Docker volume pre-population behaviour; not a Coolify feature). So if the image already has `/app/storage` owned by `node:node`, a fresh named volume comes up writable by node. This does not help if the volume was already created by an earlier deploy while the path was root-owned, and it never applies to bind mounts.
- **Safest Dockerfile approach (works for both fresh and pre-existing volumes and for bind mounts):** build the image so `/app/storage` exists and is chowned to node, keep root only for an entrypoint that fixes ownership of the mount, then drop to `node` with `gosu` (Debian) or `su-exec` (Alpine):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
# build tools only matter if better-sqlite3 has no prebuilt binary for this node/libc combo
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* && npm ci --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/storage && chown -R node:node /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
```

```sh
#!/bin/sh
# docker-entrypoint.sh
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/storage
  # only fix what is wrong; a full chown -R on thousands of PDFs slows every start
  find /app/storage ! -user node -exec chown node:node {} + 2>/dev/null || chown -R node:node /app/storage
  exec gosu node "$@"
fi
exec "$@"
```

  Notes: (1) always `RUN chmod +x` the entrypoint inside the Dockerfile - Git on Windows often loses the exec bit and Coolify builds fail with `exec: "/app/entrypoint.sh": permission denied`; (2) add `storage/` and `node_modules/` to `.dockerignore`; (3) do NOT add `--user 1000:1000` in Custom Docker Options - that prevents the root entrypoint from fixing ownership; (4) if you prefer no entrypoint, the minimal alternative is `RUN mkdir -p /app/storage && chown node:node /app/storage` + `USER node` and rely on named-volume pre-population, but then a volume that was ever created root-owned must be fixed once by hand (`docker run --rm -v <app-uuid>-storage:/s alpine chown -R 1000:1000 /s`).
- SQLite-specific: use `PRAGMA journal_mode=WAL`. During a rolling update the old and new containers briefly run at the same time against the same volume; WAL mode handles that, but keep boot-time migrations idempotent.

## 3. Environment variables

Docs: https://coolify.io/docs/applications/configuration/environment-variables, https://coolify.io/docs/knowledge-base/environment-variables

- **`Configuration -> Environment Variables`**. **Normal view**: add one variable at a time with **Name**, **Value**, and checkboxes: **`Build Variable`** (available during `docker build`) and **`Runtime Variable`** (available in the running container). Default = both. Extra flags: **`Multiline`** (keys/certs), **`Literal`** (keep `$` untouched, no expansion). **Developer view**: paste `.env`-format text; saving it creates/updates/removes entries to match; lines starting with `#` are ignored; locked ("shown once") secrets and multiline values cannot be edited there.
- **Secrets**: keep them **runtime-only** (uncheck Build Variable). Build args "can remain visible in image metadata" (`docker history`). If a build genuinely needs a secret, use the **`Use Docker Build Secrets`** option (BuildKit) instead of a build arg.
- How build vars reach a Dockerfile: with **`Configuration -> Advanced -> Inject Build Args to Dockerfile`** ON (default) Coolify passes build-flagged variables as `--build-arg` and prepends matching `ARG` lines; turn it off if your Dockerfile declares its own `ARG`s. `SOURCE_COMMIT` is excluded from the build by default (layer-cache friendliness; toggle **`Include Source Commit in Build`**).
- Predefined variables Coolify injects: `COOLIFY_FQDN`, `COOLIFY_URL`, `COOLIFY_BRANCH`, `COOLIFY_RESOURCE_UUID`, `SOURCE_COMMIT`, plus `PORT`/`HOST`. Do not rely on `PORT` being set for Dockerfile builds - set `ENV PORT=3000` yourself and read `process.env.PORT || 3000`.
- Applying changes: build-time change -> **Redeploy**; runtime-only change -> **Restart** is enough.
- Shared variables: `{{team.X}}`, `{{project.X}}`, `{{environment.X}}` references are supported.

## 4. Health checks and the "unhealthy" trap

Docs: https://coolify.io/docs/knowledge-base/health-checks, https://coolify.io/docs/applications/configuration/health-checks, https://coolify.io/docs/knowledge-base/rolling-updates, https://coolify.io/docs/troubleshoot/applications/no-available-server, https://coolify.io/docs/troubleshoot/applications/bad-gateway

- Two sources of truth: (a) **`HEALTHCHECK`** in the Dockerfile; (b) **`Configuration -> Healthcheck`** in the dashboard (**`Enable Healthcheck`** toggle; **Type** HTTP/CMD; **Method** GET/POST; **Scheme**; **Host** `localhost`; **Port** - "defaults to first value from Ports Exposes"; **Path** e.g. `/health`; **Return Code** / **Response Text** (currently ignored - only the command exit status counts); **Interval (s)**, **Timeout (s)**, **Retries**, **Start Period (s)**). For a non-Compose Dockerfile app, "Coolify detects the image's HEALTHCHECK and uses it instead of adding the health check configured in the dashboard" - the Dockerfile wins.
- The dashboard HTTP check is executed **inside the container** as `curl`/`wget`, so **the image must contain curl or wget** (`node:*-slim` has neither -> install `curl`; `node:*-alpine` has busybox `wget`). Missing binary = check always fails = container `(unhealthy)`.
- What "healthy" means to Coolify: with no health check at all, "Coolify treats a successfully started container as ready" (deploy succeeds as soon as the container is running). With a health check, Coolify waits for Docker's health state; with rolling updates it "keeps the current container when the replacement becomes unhealthy" (deployment fails, old version keeps serving). Traefik also drops unhealthy containers from routing: "If all containers fail checks, Traefik may return 404 Not Found or No available server".
- Pitfalls:
  1. **App bound to `127.0.0.1`**: the in-container health check (`localhost`) PASSES, but Traefik cannot connect -> **502 Bad Gateway**. Bind to `0.0.0.0`.
  2. **Wrong port**: health check on a port the app does not use -> unhealthy -> "No available server"/404; wrong **Ports Exposes** -> 502. The Port field must be the **internal container port**, never a host/public port.
  3. **Start Period too short** for migrations/startup -> retries exhausted -> unhealthy (GitHub issue #7500 shows exactly this with a Dockerfile-built Node app: "curl(7)" / "connection refused"). Use `--start-period=20s` or more.
  4. `/health` should return 200 only when the DB is open and the app is ready.
- Diagnosis: `docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`, `docker inspect --format '{{json .State.Health}}' <container>`, run the check by hand in the app's **`Terminal`** tab (`command -v curl || command -v wget`, then `curl --fail http://localhost:3000/health`), and check proxy logs at `Servers -> <server> -> Proxy -> Logs` or `docker logs coolify-proxy --tail 50`. Emergency workaround: disable the health check so a running container is routed.

## 5. Redeploy on push, manual redeploy, logs

Docs: https://coolify.io/docs/applications/sources/github/auto-deploy, https://coolify.io/docs/applications/deployments/manual-webhooks, https://coolify.io/docs/core/automation/deploy-webhooks, https://coolify.io/docs/applications/sources/github/actions, https://coolify.io/docs/applications/operations/overview, https://coolify.io/docs/applications/deployments/overview

- **GitHub App source**: **`Configuration -> Advanced -> Auto Deploy`** is ON by default; every push to the configured branch triggers a deployment (other branches are ignored). Optional **Watch Paths** limit which changed files trigger a build. Verify by pushing a commit and watching **`Deployments`**.
- **Public repo or Deploy Key source** (manual webhook): app -> **`Configuration -> Webhooks`** -> **`Manual Git Webhooks`** -> enter a long random **`GitHub Webhook Secret`** -> **`Save`** -> copy the GitHub URL (format `https://<coolify-host>/webhooks/source/github/events/manual`). In GitHub: `Settings -> Webhooks -> Add webhook` -> Payload URL = that URL, Content type `application/json`, Secret = same value, **"Just the push event"**. Make sure **Auto Deploy** is enabled in `Configuration -> Advanced`. GitHub must be able to reach your Coolify host over HTTPS.
- **Deploy Webhook (token)**: `Configuration -> Webhooks` -> copy **`Deploy Webhook (auth required)`**: `https://<coolify-host>/api/v1/deploy?uuid=<app-uuid>&force=false`. Call with `Authorization: Bearer <token>` (token needs the `deploy` permission). GitHub Actions example from the docs:
  ```yaml
  - name: Trigger Coolify deployment
    run: |
      curl --fail --request GET '${{ secrets.COOLIFY_WEBHOOK }}' \
        --header 'Authorization: Bearer ${{ secrets.COOLIFY_TOKEN }}'
  ```
- **Manual buttons** on the application page: **`Deploy`** (first deploy), **`Redeploy`** (normal flow again), **`Restart`** (reuse existing image, no rebuild - use after runtime-only env changes), **`Force deploy (without cache)`**, **`Stop`**. Deployments are queued (`queued / in progress / successful / failed / cancelled`). "A failed source build does not replace the running application."
- **Logs**: **`Deployments`** -> open one -> build log (checkout, image build, generated config, container actions; start from the first failing command). **`Logs`** -> runtime stdout/stderr of the current container(s), filterable by server/container. **`Terminal`** -> shell into the container. Proxy logs: `Servers -> <server> -> Proxy -> Logs`.

## 6. Coolify API alternative

Docs: https://coolify.io/docs/api/overview, https://coolify.io/docs/core/security/credentials/api-tokens, https://coolify.io/docs/api-reference/authorization, https://coolify.io/docs/api/ip-allowlist, https://coolify.io/docs/api-reference/api/operations/create-public-application, https://coolify.io/docs/api-reference/api/operations/deploy-by-tag-or-uuid, https://coolify.io/docs/api-reference/api/operations/list-projects, https://coolify.io/docs/api-reference/api/operations/list-servers, https://coolify.io/docs/api-reference/api/operations/create-env-by-application-uuid

1. **Enable the API (self-hosted)**: **`Settings -> Configuration -> Advanced`** -> turn on **`API Access`**; optionally **`Allowed IPs for API Access`** (IP or CIDR). Note from the IP-allowlist doc: a client running in a container on the `coolify` network arrives with its container IP, not a public IP.
2. **Create a token**: sidebar **`Keys & Tokens`** -> **`API Tokens`** -> **Description** (3-255 chars) -> **Expiration** (7/30/60/90 days, 1 year, Never) -> permissions: `read` (list/inspect, secrets redacted), `read:sensitive`, `write` (create/update/delete; needs team admin/owner), `deploy` (trigger deploy/restart/stop/webhooks), `root` (bypass all) -> **`Create`** -> copy immediately (shown once). Token format `<id>|<secret>`; header `Authorization: Bearer <token>`. For this job: `read` + `write` + `deploy` (or `root`).
3. **Base URL**: `https://<coolify-host>/api/v1`. Health: `GET /api/v1/health` (no auth).
4. **Find UUIDs**:
   ```bash
   export COOLIFY_URL=https://coolify.example.com COOLIFY_TOKEN='<id>|<secret>'
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/servers"    # -> [{uuid,name,ip,proxy_type,...}]
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/projects"   # -> [{uuid,name,...}]
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/projects/<project_uuid>"   # environments (name/uuid)
   ```
5. **Create the app from a public repo** (`POST /api/v1/applications/public`, returns `201 {"uuid": "..."}`; `409` if the domain is already used):
   ```bash
   curl -s -X POST "$COOLIFY_URL/api/v1/applications/public" \
     -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "project_uuid": "<project_uuid>",
       "server_uuid": "<server_uuid>",
       "environment_name": "production",
       "git_repository": "https://github.com/<owner>/<repo>",
       "git_branch": "main",
       "build_pack": "dockerfile",
       "base_directory": "/",
       "dockerfile_location": "/Dockerfile",
       "ports_exposes": "3000",
       "domains": "https://suite.glasspro.co.id",
       "name": "glasspro-suite",
       "is_auto_deploy_enabled": true,
       "is_force_https_enabled": true,
       "health_check_enabled": true,
       "health_check_path": "/health",
       "health_check_port": "3000",
       "health_check_start_period": 20,
       "instant_deploy": false
     }'
   ```
   Required: `project_uuid`, `server_uuid`, `environment_name` **or** `environment_uuid`, `git_repository`, `git_branch`, `build_pack` (`nixpacks|railpack|static|dockerfile|dockercompose`). Optional: `ports_exposes`, `domains`, `dockerfile_location`, `base_directory`, `instant_deploy`, `health_check_*` (`enabled,path,port,host,method,return_code,scheme,response_text,interval,timeout,retries,start_period`), `limits_*`, `is_auto_deploy_enabled`, `is_force_https_enabled`, `is_preview_deployments_enabled`, `tags`. Private variants: `POST /applications/private-github-app` (add `github_app_uuid`) and `POST /applications/private-deploy-key` (add `private_key_uuid`), otherwise same body.
6. **Environment variables** (`POST /api/v1/applications/<uuid>/envs`, one per call; bulk `PATCH .../envs/bulk` per the docs' "Update Envs (Bulk)"):
   ```bash
   curl -s -X POST "$COOLIFY_URL/api/v1/applications/<app_uuid>/envs" \
     -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
     -d '{"key":"SHOPEE_PARTNER_KEY","value":"...","is_preview":false,"is_literal":true,"is_buildtime":false,"is_runtime":true}'
   ```
   The response schema uses `is_buildtime` / `is_runtime`; sending `is_build_time` returns `422 "This field is not allowed"` (GitHub issue #6847).
7. **Persistent storage**: no application volume/storage endpoint was found in the OpenAPI spec - add the `/app/storage` Volume Mount through the UI (section 2) before the first deploy.
8. **Trigger deploy** (`POST /api/v1/deploy`, query or JSON body; needs `deploy` permission):
   ```bash
   curl -s -X POST "$COOLIFY_URL/api/v1/deploy?uuid=<app_uuid>&force=false" -H "Authorization: Bearer $COOLIFY_TOKEN"
   # or JSON:
   curl -s -X POST "$COOLIFY_URL/api/v1/deploy" -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" -d '{"uuid":"<app_uuid>","force":false}'
   # -> {"deployments":[{"message":"...","resource_uuid":"...","deployment_uuid":"..."}]}
   ```
   Params: `uuid` or `tag` (comma-separated lists OK, not both), `force` (rebuild without cache), `pr`/`pull_request_id` (preview), `docker_tag`.

## 7. Outbound IP (Shopee whitelist)

- Coolify's own docs do not state the egress IP explicitly; the networking page only covers inbound (https://coolify.io/docs/core/networking-in-coolify). Standard Docker behaviour applies: Coolify deploys the app onto the attachable user-defined bridge network `coolify`; outbound traffic from that network is SNAT/MASQUERADEd by Docker's iptables rules to the host's IP on the interface of the default route. So on a normal VPS whose public IPv4 sits on the NIC, **Shopee sees the VPS public IPv4 - the same address you see from an SSH shell**. Coolify does not add any NAT gateway, tunnel or proxy on the egress path.
- Verify empirically (do this before whitelisting): from SSH `curl -s https://api.ipify.org`, and from the app's **`Terminal`** tab `wget -qO- https://api.ipify.org` (or `curl -s https://api.ipify.org`). The two must match.
- Things that could make them differ: (1) the server has several public IPs / a floating IP and the kernel's preferred source address is a different one - check `ip route get 1.1.1.1`; (2) **IPv6**: if the host has a global IPv6 address and the Docker network has IPv6 enabled, connections to dual-stack endpoints may leave over IPv6 with a different address; `docker network inspect coolify --format '{{json .EnableIPv6}}'` shows whether the network is IPv6-enabled (Coolify's default `coolify` network is IPv4-only as far as I can tell - unverified); (3) a VPN/Tailscale exit node or provider NAT on the host changes the default route for containers too; (4) a Cloudflare Tunnel (if you ever add one) affects inbound only. Only traffic from a container **to Coolify itself** shows the container's private address (https://coolify.io/docs/api/ip-allowlist) - irrelevant for Shopee.
- Practical rule: whitelist the VPS public IPv4 with Shopee, keep the app IPv4-only (or make sure any AAAA/IPv6 egress address is whitelisted too), and re-verify after any server migration (Coolify "migrate apps to different host" changes the IP).

## Quick end-to-end checklist (UI)
1. DNS A record -> VPS IP; ports 80/443 open; Cloudflare grey-cloud. 2. (Private repo) add GitHub App under Sources or a deploy key under Keys & Tokens. 3. Projects -> env -> `+ New` -> repo type -> server -> branch. 4. Build Pack `Dockerfile`, Base Directory `/`, Dockerfile Location `/Dockerfile`, Ports Exposes `3000`, Domains `https://suite.glasspro.co.id`, Ports Mappings empty. 5. Persistent Storage -> Add -> Volume Mount, name `storage`, destination `/app/storage`. 6. Environment Variables -> add secrets as runtime-only. 7. Healthcheck: either rely on the Dockerfile HEALTHCHECK (curl installed, `/health`, start-period 20s) or enable the dashboard check with Port 3000 / Path `/health`. 8. Deploy; watch Deployments log; open https://suite.glasspro.co.id; check Logs. 9. Confirm Auto Deploy (Advanced) is on; for public/deploy-key sources add the manual GitHub webhook. 10. From Terminal tab: `wget -qO- https://api.ipify.org` and whitelist that IP at Shopee.

## Uncertainties
- Exact wording of the 'new resource' button varies between doc pages/versions ('+ New', 'Create New Resource', '+ Add Resource'); it is the same action. Tab names like 'Persistent Storage' vs older 'Storages' also depend on the Coolify version installed on the VPS.
- Env-var API build-time flag: the response schema uses is_buildtime/is_runtime and is_build_time is rejected (GitHub issue #6847), but the create endpoint's documented body only lists key/value/is_preview/is_literal/is_multiline/is_shown_once, so whether is_buildtime is accepted on POST (vs defaulting to true for both) is not confirmed. If unsure, set the flag in the UI.
- No API endpoint for application persistent storage/volumes was found in the OpenAPI spec fetched from GitHub main; a newer Coolify release may have one. Plan to add the volume via the UI.
- Outbound IP behaviour is inferred from standard Docker MASQUERADE behaviour; Coolify docs do not state it explicitly. Whether the default `coolify` Docker network is IPv6-enabled was not verified - check with `docker network inspect coolify` and test with ipify from the app Terminal.
- Docker named-volume pre-population (copying the image directory's contents and ownership into a new empty named volume on first mount) is documented Docker behaviour but was not re-verified from docs.docker.com in this session; it only applies to a brand-new empty named volume, never to bind/directory mounts.
- The default values Coolify pre-fills on the Healthcheck page (interval/timeout/retries/start period, default path) and how long the deployment job waits before declaring the new container unhealthy are not stated in the docs; read them off the screen.
- Whether Coolify injects a PORT env var into Dockerfile-built containers is not clearly documented (the docs list PORT/HOST as predefined vars without details); set ENV PORT=3000 in the Dockerfile to be safe.
- better-sqlite3 prebuilt binaries: available for linux-x64 glibc (node:*-slim) in current releases; availability for musl/alpine and for very new Node majors was not verified - the Dockerfile keeps python3/make/g++ in the deps stage so a source build works either way.
- The GitHub issue #3440 on non-root volume ownership had no visible maintainer resolution at the time of fetching; the entrypoint-chown approach is the community-standard workaround, not an official Coolify recommendation.
- Whether 'Response Text' / 'Return Code' health-check fields are still ignored (docs say only exit status is evaluated 'currently') may change in future Coolify versions.

## Sources
- https://coolify.io/docs/applications/build-packs/dockerfile
- https://coolify.io/docs/builds/packs/dockerfile
- https://coolify.io/docs/applications/configuration/general
- https://coolify.io/docs/applications/configuration/advanced
- https://coolify.io/docs/knowledge-base/domains
- https://coolify.io/docs/knowledge-base/dns-configuration
- https://coolify.io/docs/knowledge-base/proxy/traefik/overview
- https://coolify.io/docs/knowledge-base/proxy/caddy/overview
- https://coolify.io/docs/knowledge-base/proxy/traefik/dns-challenge
- https://coolify.io/docs/troubleshoot/dns-and-domains/lets-encrypt-not-working
- https://coolify.io/docs/knowledge-base/server/firewall
- https://coolify.io/docs/core/networking-in-coolify
- https://coolify.io/docs/knowledge-base/git/github/integration
- https://coolify.io/docs/applications/sources/github/app
- https://coolify.io/docs/applications/sources/github/deploy-key
- https://coolify.io/docs/applications/sources/github/auto-deploy
- https://coolify.io/docs/applications/deployments/manual-webhooks
- https://coolify.io/docs/core/automation/deploy-webhooks
- https://coolify.io/docs/applications/sources/github/actions
- https://coolify.io/docs/applications/operations/overview
- https://coolify.io/docs/applications/deployments/overview
- https://coolify.io/docs/knowledge-base/rolling-updates
- https://coolify.io/docs/knowledge-base/persistent-storage
- https://coolify.io/docs/core/persistent-storage/storage-mounts/overview
- https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts
- https://coolify.io/docs/core/persistent-storage/storage-mounts/bind-mounts
- https://coolify.io/docs/applications/configuration/persistent-storage
- https://coolify.io/docs/core/docker-and-containers
- https://github.com/coollabsio/coolify/issues/3440
- https://coolify.io/docs/applications/configuration/environment-variables
- https://coolify.io/docs/knowledge-base/environment-variables
- https://coolify.io/docs/knowledge-base/health-checks
- https://coolify.io/docs/applications/configuration/health-checks
- https://coolify.io/docs/troubleshoot/applications/bad-gateway
- https://coolify.io/docs/troubleshoot/applications/no-available-server
- https://github.com/coollabsio/coolify/issues/7500
- https://coolify.io/docs/api/overview
- https://coolify.io/docs/core/security/credentials/api-tokens
- https://coolify.io/docs/api-reference/authorization
- https://coolify.io/docs/api/permissions
- https://coolify.io/docs/api/ip-allowlist
- https://coolify.io/docs/api-reference/api/operations/create-public-application
- https://coolify.io/docs/api-reference/api/operations/deploy-by-tag-or-uuid
- https://coolify.io/docs/api-reference/api/operations/list-projects
- https://coolify.io/docs/api-reference/api/operations/list-servers
- https://coolify.io/docs/api-reference/api/operations/create-env-by-application-uuid
- https://coolify.io/docs/api-reference/api/operations/list-envs-by-application-uuid
- https://github.com/coollabsio/coolify/issues/6847
- https://raw.githubusercontent.com/coollabsio/coolify/main/openapi.yaml
