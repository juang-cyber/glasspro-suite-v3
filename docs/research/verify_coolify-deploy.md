# coolify-deploy (adversarially verified and corrected)

## 0. Prerequisites (server, DNS, firewall)

- **Open TCP ports on the VPS** (https://coolify.io/docs/knowledge-base/server/firewall) [VERIFIED]: `22` (SSH), `80` (HTTP + certificate generation / Let's Encrypt HTTP-01 challenge), `443` (HTTPS). `8000` (direct dashboard access), `6001` (real-time updates via direct IP), `6002` (web terminal via direct IP) are only for reaching the Coolify dashboard by raw IP; the docs say that after configuring a dashboard domain through the proxy "you can close public access to ports 8000, 6001, and 6002". Docs: "Do not open ports that your server does not use" and "Do not remove the SSH rule while configuring the firewall". Prefer the hosting provider's firewall; if you only have a host firewall the docs point to `ufw-docker` or Compose overrides (Docker's iptables rules bypass plain `ufw`).
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
- **`Dockerfile Location`**: path **relative to Base Directory** [VERIFIED: docs say "Set Dockerfile Location to the Dockerfile path relative to that directory"], default `/Dockerfile`. So with the Dockerfile at the repo root, keep Base Directory `/` and Dockerfile Location `/Dockerfile`.
- **`Ports Exposes`**: the port the process listens on **inside the container** (the UI pre-fills a value - commonly `3000`; the default is not documented, so check the field and change it to your app's port). The health-check docs confirm: when the health-check Port is empty, "Coolify uses the first value from Ports Exposes". The Dockerfile docs stress [VERIFIED]: "The process must listen on `0.0.0.0`, not only `127.0.0.1`, for the Coolify proxy to reach it." In Express: `app.listen(process.env.PORT || 3000, '0.0.0.0')`.
- **`Ports Mappings`** (`host:container`): LEAVE EMPTY. Publishing a host port exposes the container directly on the host (reachable without the proxy/TLS) and disables rolling updates - docs [VERIFIED]: a published host port prevents rolling updates because "Both containers cannot bind the same host port" (https://coolify.io/docs/knowledge-base/rolling-updates).
- **`Docker Build Stage Target`**, **`Custom Docker Options`**, **`Network Aliases`**, **`Pre/Post-deployment command`**: optional.
- **`Domains`**: full URL(s) **with scheme**, comma-separated [VERIFIED: "Separate multiple domains with commas"]: `https://suite.glasspro.co.id`. Coolify offers a **`Generate Domain`** button that uses the server's wildcard domain (a `sslip.io`-style temporary domain on fresh installs) - replace/ignore it. Optional forms [VERIFIED]: `https://host:3000` ("A port in the domain tells Coolify Proxy which port to use inside the container"; only needed for multi-port apps), `https://host/api` (path routing; prefix is stripped unless you turn off **`Strip Prefixes`** in Advanced). Do not reuse the same domain on two resources.
- **`Direction`** (API field `redirect`, values `www | non-www | both`): `Allow www & non-www` / `Redirect to www` / `Redirect to non-www` [VERIFIED] (only relevant if you also add `https://www...` to Domains with its own DNS record; docs: both forms must exist in DNS first).
- **`Configuration -> Advanced`**: **`Force HTTPS`** (default on; HTTP -> HTTPS redirect), **`Inject Build Args to Dockerfile`** (default on; see section 3), **`Deployment -> Auto Deploy`** (see section 5).
- Click **`Deploy`**. Follow the build in **`Deployments`** -> open the running deployment.

### 1c. How the domain becomes HTTPS
- Coolify writes Traefik Docker labels on the container: router rule `Host(suite.glasspro.co.id)`, service port = Ports Exposes, TLS cert resolver `letsencrypt` (HTTP-01 challenge) (https://coolify.io/docs/knowledge-base/proxy/traefik/overview). The `coolify-proxy` container listens on 80/443 and forwards over the shared `coolify` Docker network to the container's internal port - the container itself publishes nothing on the host (https://coolify.io/docs/core/networking-in-coolify).
- Using `https://` in Domains triggers automatic Let's Encrypt issuance and renewal (90-day certs). Requirements: DNS already resolving to this server, ports 80 and 443 publicly reachable, no interfering CDN proxy.
- Caddy alternative (https://coolify.io/docs/knowledge-base/proxy/caddy/overview): `Servers -> <server> -> Proxy` -> switch type. Uses `lucaslorentz/caddy-docker-proxy`, automatic HTTPS, also listens 80/443 (+HTTP/3 UDP 443). Traefik and Caddy configs are not interchangeable; core team runs Traefik in production - stay on Traefik unless you have a reason.
- Cert troubleshooting: `Servers -> <server> -> Proxy -> Logs` (look for 429 rate-limit or 403 WAF errors); nuclear option `rm /data/coolify/proxy/acme.json` then restart the proxy.

## 2. Persistent storage for `/app/storage` (SQLite DB + generated PDFs)

Docs: https://coolify.io/docs/core/persistent-storage/storage-mounts/overview, https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts, https://coolify.io/docs/core/persistent-storage/storage-mounts/bind-mounts, https://coolify.io/docs/knowledge-base/persistent-storage

### 2a. UI steps (recommended: named Volume Mount) [VERIFIED against volume-mounts doc]
1. Open the application -> **`Configuration -> Persistent Storage`** -> **`Add`** -> **`Volume Mount`**.
2. **`Name`**: e.g. `storage`. Docs: "Coolify prefixes the name with the resource UUID to prevent name collisions on the deployment server. The name shown by `docker volume ls` is therefore longer than the value entered in Name" (in practice `<app-uuid>-storage`; check `docker volume ls`).
3. **`Source Path`**: leave **empty** (docs: "Entering a source path creates a bind mount instead of a named volume").
4. **`Destination Path`**: `/app/storage` (must be the exact directory your code writes to - "/app is common, but it is not a universal container base directory").
5. Click **`Add`**, then **Redeploy** (docs: "Redeploy the resource so Docker creates the new container with the mount attached").
6. Verify: write a file, redeploy again, confirm it is still there.

Other mount types: **`Directory Mount`** = bind mount to a host dir Coolify creates under `/data/coolify/applications/<uuid>/...` (removing it from the UI can DELETE the host data; back up first). **`File Mount`** = single Coolify-managed file - NOT suitable for SQLite (the `-wal`/`-shm` sidecar files must live next to the DB, so always mount the directory, never the `.db` file).

Guardrails from the docs: keep **`Delete Unused Volumes`** (server cleanup setting) disabled unless you have backed up every volume; persistent storage is not a backup - use the app's **`Backups`** page (scheduled storage backups exist for volume/directory mounts; API: `/applications/{uuid}/storages/{storage_uuid}/backups` and `.../backups/run`); storage is local to the one server and "multi-server applications cannot use persistent storage".

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

- **`Configuration -> Environment Variables`**. **Normal view**: add one variable at a time with **Name**, **Value**, and checkboxes: **`Build Variable`** (available during `docker build`) and **`Runtime Variable`** (available in the running container). Default = both enabled [VERIFIED]. Extra flags: **`Multiline`** (keys/certs), **`Literal`** (keep `$` untouched, no expansion). **Developer view**: paste `.env`-format text; "Saving Developer view creates, updates, and removes entries to match its contents"; "Lines beginning with `#` are ignored"; "Locked secrets and multiline values cannot be edited in Developer view" [VERIFIED].
- **Secrets**: keep them **runtime-only** (uncheck Build Variable). Build args "may remain visible in image metadata" (`docker history`). If a build genuinely needs a secret, use the **`Use Docker Build Secrets`** option (requires BuildKit on the build server; otherwise "Coolify falls back to build arguments") [VERIFIED].
- How build vars reach a Dockerfile: with **`Configuration -> Advanced -> Inject Build Args to Dockerfile`** ON (default) Coolify passes build-flagged variables as `--build-arg` and prepends matching `ARG` lines; docs [VERIFIED]: disable it "when the Dockerfile declares and consumes every required `ARG` itself". `SOURCE_COMMIT` is excluded from the build by default (layer-cache friendliness; toggle **`Include Source Commit in Build`**).
- Predefined variables Coolify injects [VERIFIED]: `COOLIFY_FQDN`, `COOLIFY_URL`, `COOLIFY_BRANCH`, `COOLIFY_RESOURCE_UUID`, `SOURCE_COMMIT`, plus **`PORT` = first exposed port (Ports Exposes) if you have not set it yourself** and **`HOST` = `0.0.0.0` if not pre-set**. Setting `ENV PORT=3000` in the Dockerfile and reading `process.env.PORT || 3000` is still the safe pattern (your own value wins).
- Applying changes [VERIFIED]: build-time change -> new deployment (**Redeploy**); runtime-only change -> **Restart** is enough.
- Shared variables: `{{team.X}}`, `{{project.X}}`, `{{environment.X}}` references are supported.

## 4. Health checks and the "unhealthy" trap

Docs: https://coolify.io/docs/knowledge-base/health-checks, https://coolify.io/docs/applications/configuration/health-checks, https://coolify.io/docs/knowledge-base/rolling-updates, https://coolify.io/docs/troubleshoot/applications/no-available-server, https://coolify.io/docs/troubleshoot/applications/bad-gateway

- Two sources of truth: (a) **`HEALTHCHECK`** in the Dockerfile; (b) **`Configuration -> Healthcheck`** in the dashboard (**`Enable Healthcheck`** toggle; **Type** HTTP/CMD; **Method** GET/POST; **Scheme** http/https; **Host** `localhost`; **Port** - "when empty, Coolify uses the first value from Ports Exposes"; **Path** e.g. `/health`; **Return Code** / **Response Text** (ignored - docs: "the generated check does not compare the response against those two fields"; only the curl/wget exit status counts); **Interval (s)** (min 1), **Timeout (s)** (min 1), **Retries** (min 1), **Start Period (s)**) [VERIFIED]. For a non-Compose Dockerfile app [VERIFIED verbatim]: "Coolify detects the image's HEALTHCHECK and uses it instead of adding the health check configured in the dashboard" - the Dockerfile wins.
- The dashboard HTTP check is executed **inside the container** as `curl`/`wget`, so **the image must contain curl or wget** - docs [VERIFIED]: "The final application image must contain curl or wget; installing either command only on the deployment server is not enough." (`node:*-slim` has neither -> install `curl`; `node:*-alpine` has busybox `wget`). Missing binary = check always fails = container `(unhealthy)`.
- What "healthy" means to Coolify [VERIFIED in rolling-updates doc]: "Without a health check, Coolify treats a successfully started container as ready" (deploy succeeds as soon as the container is running; it "cannot determine whether the application has finished initialization"). With a health check, Coolify waits for Docker's health state; with rolling updates it "keeps the current container when the replacement becomes unhealthy" (deployment fails, old version keeps serving). Traefik also drops unhealthy containers from routing: "If all containers fail checks, Traefik may return 404 Not Found or No available server".
- Pitfalls:
  1. **App bound to `127.0.0.1`**: the in-container health check (`localhost`) PASSES, but Traefik cannot connect -> **502 Bad Gateway**. Bind to `0.0.0.0`.
  2. **Wrong port**: health check on a port the app does not use -> unhealthy -> "No available server"/404; wrong **Ports Exposes** -> 502. The Port field must be the **internal container port**, never a host/public port.
  3. **Start Period too short** for migrations/startup -> retries exhausted -> unhealthy (GitHub issue #7500 shows exactly this with a Dockerfile-built Node app: "curl(7)" / "connection refused"). Use `--start-period=20s` or more.
  4. `/health` should return 200 only when the DB is open and the app is ready.
- Diagnosis: `docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`, `docker inspect --format '{{json .State.Health}}' <container>`, run the check by hand in the app's **`Terminal`** tab (`command -v curl || command -v wget`, then `curl --fail http://localhost:3000/health`), and check proxy logs at `Servers -> <server> -> Proxy -> Logs` or `docker logs coolify-proxy --tail 50`. Emergency workaround: disable the health check so a running container is routed.

## 5. Redeploy on push, manual redeploy, logs

Docs: https://coolify.io/docs/applications/sources/github/auto-deploy, https://coolify.io/docs/applications/deployments/manual-webhooks, https://coolify.io/docs/core/automation/deploy-webhooks, https://coolify.io/docs/applications/sources/github/actions, https://coolify.io/docs/applications/operations/overview, https://coolify.io/docs/applications/deployments/overview

- **GitHub App source**: **`Configuration -> Advanced -> Deployment -> Auto Deploy`** is ON by default; every push to the configured branch triggers a deployment (other branches are ignored). Optional **Watch Paths** limit which changed files trigger a build. Verify by pushing a commit and watching **`Deployments`**.
- **Public repo or Deploy Key source** (manual webhook) [VERIFIED against docs + source]: first make sure **Auto Deploy** is enabled in `Configuration -> Advanced -> Deployment`. Then app -> **`Configuration -> Webhooks`** -> section **`Manual Git webhooks`** (only shown when the app is not connected through a Git App) -> enter a long random value in the GitHub **Webhook secret** field (docs call it "GitHub Webhook Secret") -> **`Save`** -> copy the GitHub URL. Its format is `https://<coolify-host>/webhooks/source/github/events/manual` (confirmed from Coolify source: `RouteServiceProvider` mounts `routes/webhooks.php` under prefix `webhooks`, which defines `POST /source/github/events/manual`; helper `generateGitManualWebhook()` returns `<base_url>/webhooks/source/<type>/events/manual`). In GitHub: `Settings -> Webhooks -> Add webhook` -> Payload URL = that URL, Content type `application/json` (docs also accept `application/x-www-form-urlencoded`), Secret = same value ("must exactly match"), keep "Enable SSL verification", **"Just the push event"** (or Pushes + Pull requests if you use preview deployments). GitHub must be able to reach your Coolify host over HTTPS.
- **Deploy Webhook (token)** [VERIFIED]: `Configuration -> Webhooks` -> section **`Deploy webhook`** -> copy button **`Deploy webhook URL`**: `https://<coolify-host>/api/v1/deploy?uuid=<app-uuid>&force=false` (source: `generateDeployWebhook()` returns exactly `<base_url>/api/v1/deploy?uuid=$uuid&force=false`). Call with `Authorization: Bearer <token>` (token needs the `deploy` permission - docs: a deploy-only scope "can trigger deploy webhooks without receiving general read or write access to the API"). Docs: the deploy webhook accepts both GET and POST. GitHub Actions example from the docs:
  ```yaml
  - name: Trigger Coolify deployment
    run: |
      curl --fail --request GET '${{ secrets.COOLIFY_WEBHOOK }}' \
        --header 'Authorization: Bearer ${{ secrets.COOLIFY_TOKEN }}'
  ```
- **Manual buttons** on the application page: **`Deploy`** (first deploy), **`Redeploy`** (normal flow again), **`Restart`** (reuse existing image, no rebuild - use after runtime-only env changes), **`Force deploy (without cache)`**, **`Stop`**. Deployments are queued (`queued / in progress / successful / failed / cancelled`). "A failed source build does not replace the running application."
- **Logs**: **`Deployments`** -> open one -> build log (checkout, image build, generated config, container actions; start from the first failing command). **`Logs`** -> runtime stdout/stderr of the current container(s), filterable by server/container. **`Terminal`** -> shell into the container. Proxy logs: `Servers -> <server> -> Proxy -> Logs`.

## 6. Coolify API alternative

Docs: https://coolify.io/docs/api/overview, https://coolify.io/docs/core/security/credentials/api-tokens, https://coolify.io/docs/api-reference/authorization, https://coolify.io/docs/api/ip-allowlist, https://coolify.io/docs/api-reference/api/operations/create-public-application, https://coolify.io/docs/api-reference/api/operations/deploy-by-tag-or-uuid, https://coolify.io/docs/api-reference/api/operations/list-projects, https://coolify.io/docs/api-reference/api/operations/list-servers, https://coolify.io/docs/api-reference/api/operations/create-env-by-application-uuid. Spec: https://raw.githubusercontent.com/coollabsio/coolify/main/openapi.yaml

1. **Enable the API (self-hosted)** [VERIFIED]: **`Settings -> Configuration -> Advanced`** -> turn on **`API Access`**; optionally **`Allowed IPs for API Access`** (IP or CIDR). Note from the IP-allowlist doc: a client running in a container on the `coolify` network arrives with its container IP, not a public IP.
2. **Create a token** [VERIFIED]: sidebar **`Keys & Tokens`** -> **`API Tokens`** -> **Description** ("must contain between 3 and 255 characters") -> **Expiration** (7 days, 30 days, 60 days, 90 days, 1 year, Never) -> permissions: `read` ("List and inspect resources."), `read:sensitive` ("Read secrets, logs, passwords, private keys, environment values, and Compose content"), `write` ("Create, update, and delete resources through write endpoints."), `deploy` ("Trigger deployments, restarts, stops, cancellations, and deploy webhooks."), `root` ("Bypass the read, write, and deploy permission checks on API endpoints.") -> **`Create`** -> copy immediately (shown once). Header `Authorization: Bearer <token>`. (Token string looks like `<id>|<secret>` - Laravel Sanctum convention, not stated in the docs.) For this job: `read` + `write` + `deploy` (or `root`).
3. **Base URL** [VERIFIED]: `https://<coolify-host>/api/v1`. Health: `GET /api/v1/health` (also `GET /api/health`; no auth, returns `OK`).
4. **Find UUIDs**:
   ```bash
   export COOLIFY_URL=https://coolify.example.com COOLIFY_TOKEN='<id>|<secret>'
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/servers"    # -> [{uuid,name,ip,proxy_type,...}]
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/projects"   # -> [{uuid,name,...}]
   curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/projects/<project_uuid>"   # environments (name/uuid)
   ```
5. **Create the app from a public repo** (`POST /api/v1/applications/public`, returns `201 {"uuid": "..."}`; `409` if the domain is already used - message "Domain conflicts detected. Use force_domain_override=true to proceed." with a `conflicts[]` array; `422 {"message":"Validation failed.","errors":{...}}` for bad values or any unknown body field ("This field is not allowed."); `422` "You need to provide at least one of environment_name or environment_uuid." if both are missing) [VERIFIED against OpenAPI + controller source]:
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
   Required: `project_uuid`, `server_uuid`, `environment_name` **or** `environment_uuid`, `git_repository`, `git_branch`, `build_pack` (`nixpacks|railpack|static|dockerfile|dockercompose`). Optional: `ports_exposes` (string, comma-separated numbers only, regex `^\d+(,\d+)*$`), `ports_mappings`, `domains` (comma-separated URLs), `noindex_domains`, `redirect` (`www|non-www|both`), `dockerfile_location`, `base_directory`, `destination_uuid`, `name` (max 255), `description`, `instant_deploy`, `health_check_*` (`enabled,type,command,path,port,host,method,return_code,scheme,response_text,interval,timeout,retries,start_period`), `limits_memory|memory_swap|memory_swappiness|memory_reservation|cpus|cpuset|cpu_shares`, `custom_docker_run_options`, `custom_labels`, `pre_/post_deployment_command(_container)`, `watch_paths`, `manual_webhook_secret_github`, `use_build_server`, `use_build_secrets`, `is_auto_deploy_enabled`, `is_force_https_enabled`, `is_preview_deployments_enabled`, `force_domain_override`, `autogenerate_domain`, `tags` (array of strings, min 2 chars each). Private variants: `POST /applications/private-github-app` (adds required `github_app_uuid`) and `POST /applications/private-deploy-key` (adds required `private_key_uuid`), otherwise same body. Also exist: `POST /applications/dockerfile` (inline Dockerfile) and `POST /applications/dockerimage`.
6. **Environment variables** (`POST /api/v1/applications/<uuid>/envs`, one per call, returns `201 {"uuid": "..."}`; `PATCH .../envs` updates one and requires `key` + `value` (returns `201` with the full EnvironmentVariable object); bulk `PATCH .../envs/bulk` with body `{"data":[{...},{...}]}`):
   ```bash
   curl -s -X POST "$COOLIFY_URL/api/v1/applications/<app_uuid>/envs" \
     -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
     -d '{"key":"SHOPEE_PARTNER_KEY","value":"...","is_preview":false,"is_literal":true,"is_buildtime":false,"is_runtime":true}'
   ```
   [VERIFIED from controller source `ApplicationsController::create_env`] accepted fields are exactly `key, value, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime, comment`; `is_runtime`/`is_buildtime` default to `true` when omitted. Sending `is_build_time` returns `422 "This field is not allowed"` (GitHub issue #6847). Note the published OpenAPI/doc page for the create/update body only lists `key/value/is_preview/is_literal/is_multiline/is_shown_once` - the doc is incomplete, the code accepts the two flags.
7. **Persistent storage via API** [CORRECTED - the endpoint exists in the OpenAPI spec]: `POST /api/v1/applications/<uuid>/storages` with body `{"type":"persistent","name":"storage","mount_path":"/app/storage"}` (`type` enum `persistent|file`; `mount_path` required; `name` required for `persistent`; optional `host_path` -> bind mount instead of named volume; for `file` type: `content`, `is_directory`, `fs_path`; `additionalProperties: false`, so unknown keys -> `422`). Returns `201` (object). `GET .../storages` -> `{"persistent_storages":[...],"file_storages":[...]}`; `PATCH .../storages` (requires `type`, identify by `uuid`; `name`/`mount_path`/`host_path`/`is_preview_suffix_enabled`); `DELETE .../storages/<storage_uuid>`. Create the storage before the first deploy (or redeploy afterwards) so the container is created with the mount. The UI route (section 2) remains fine.
8. **Trigger deploy** (`POST /api/v1/deploy`, query or JSON body; needs `deploy` permission) [VERIFIED]:
   ```bash
   curl -s -X POST "$COOLIFY_URL/api/v1/deploy?uuid=<app_uuid>&force=false" -H "Authorization: Bearer $COOLIFY_TOKEN"
   # or JSON:
   curl -s -X POST "$COOLIFY_URL/api/v1/deploy" -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" -d '{"uuid":"<app_uuid>","force":false}'
   # -> {"deployments":[{"message":"...","resource_uuid":"...","deployment_uuid":"..."}]}
   ```
   Params: `uuid` or `tag` (comma-separated lists OK, not both), `force` (boolean, rebuild without cache), `pr`/`pull_request_id` (integer, preview; cannot be used with `tag`), `docker_tag` (requires `pull_request_id`). The docs note GET is accepted too (that is what the UI-generated webhook URL and the GitHub Actions example use). Follow progress: `GET /api/v1/deployments/<deployment_uuid>`, list per app: `GET /api/v1/deployments/applications/<app_uuid>?skip=0&take=10`, cancel: `POST /api/v1/deployments/<uuid>/cancel`. Also `POST /applications/<uuid>/start|stop|restart`.

## 7. Outbound IP (Shopee whitelist)

- Coolify's own docs do not state the egress IP explicitly; the networking page only covers inbound (https://coolify.io/docs/core/networking-in-coolify). Standard Docker behaviour applies: Coolify deploys the app onto the attachable user-defined bridge network `coolify`; outbound traffic from that network is SNAT/MASQUERADEd by Docker's iptables rules to the host's IP on the interface of the default route. So on a normal VPS whose public IPv4 sits on the NIC, **Shopee sees the VPS public IPv4 - the same address you see from an SSH shell**. Coolify does not add any NAT gateway, tunnel or proxy on the egress path.
- Verify empirically (do this before whitelisting): from SSH `curl -s https://api.ipify.org`, and from the app's **`Terminal`** tab `wget -qO- https://api.ipify.org` (or `curl -s https://api.ipify.org`). The two must match.
- Things that could make them differ: (1) the server has several public IPs / a floating IP and the kernel's preferred source address is a different one - check `ip route get 1.1.1.1`; (2) **IPv6**: if the host has a global IPv6 address and the Docker network has IPv6 enabled, connections to dual-stack endpoints may leave over IPv6 with a different address; `docker network inspect coolify --format '{{json .EnableIPv6}}'` shows whether the network is IPv6-enabled (Coolify's default `coolify` network is IPv4-only as far as I can tell - unverified); (3) a VPN/Tailscale exit node or provider NAT on the host changes the default route for containers too; (4) a Cloudflare Tunnel (if you ever add one) affects inbound only. Only traffic from a container **to Coolify itself** shows the container's private address (https://coolify.io/docs/api/ip-allowlist) - irrelevant for Shopee.
- Practical rule: whitelist the VPS public IPv4 with Shopee, keep the app IPv4-only (or make sure any AAAA/IPv6 egress address is whitelisted too), and re-verify after any server migration (Coolify "migrate apps to different host" changes the IP).

## Quick end-to-end checklist (UI)
1. DNS A record -> VPS IP; ports 80/443 open; Cloudflare grey-cloud. 2. (Private repo) add GitHub App under Sources or a deploy key under Keys & Tokens. 3. Projects -> env -> `+ New` -> repo type -> server -> branch. 4. Build Pack `Dockerfile`, Base Directory `/`, Dockerfile Location `/Dockerfile`, Ports Exposes `3000`, Domains `https://suite.glasspro.co.id`, Ports Mappings empty. 5. Persistent Storage -> Add -> Volume Mount, name `storage`, destination `/app/storage`. 6. Environment Variables -> add secrets as runtime-only. 7. Healthcheck: either rely on the Dockerfile HEALTHCHECK (curl installed, `/health`, start-period 20s) or enable the dashboard check with Port 3000 / Path `/health`. 8. Deploy; watch Deployments log; open https://suite.glasspro.co.id; check Logs. 9. Confirm Auto Deploy (Advanced -> Deployment) is on; for public/deploy-key sources add the manual GitHub webhook. 10. From Terminal tab: `wget -qO- https://api.ipify.org` and whitelist that IP at Shopee.

## Corrections (what changed vs. the original notes, and how each of the 8 claims was checked)

**Verified as correct (kept, sometimes with verbatim doc wording added):**
1. `POST /api/v1/applications/public` required fields (`project_uuid`, `server_uuid`, `environment_name`|`environment_uuid`, `git_repository`, `git_branch`, `build_pack` with enum `nixpacks|railpack|static|dockerfile|dockercompose`) and `201 {"uuid"}` / `409` domain conflict - confirmed in `openapi.yaml` and `ApplicationsController.php`. Added: `422` for unknown fields ("This field is not allowed.") and missing environment; the 409 message references `force_domain_override=true`; `ports_exposes` is optional but must match `^\d+(,\d+)*$`; extra accepted optional fields (`ports_mappings`, `redirect` enum `www|non-www|both`, `health_check_type/command`, `use_build_secrets`, `watch_paths`, `manual_webhook_secret_github`, `autogenerate_domain`, `tags` min 2 chars); private variants' extra required field names `github_app_uuid` / `private_key_uuid`.
2. `POST /api/v1/deploy` query params (`uuid`, `tag`, `force`, `pr`, `pull_request_id`, `docker_tag`) and response `{"deployments":[{"message","resource_uuid","deployment_uuid"}]}` - confirmed in the spec; GET acceptance confirmed in the deploy-webhooks doc. Added the deployment status/cancel endpoints.
3. Manual GitHub webhook URL `https://<host>/webhooks/source/github/events/manual` - the docs page never prints it, so it was confirmed from source: `RouteServiceProvider.php` (`Route::prefix('webhooks')->group(routes/webhooks.php)`), `routes/webhooks.php` (`POST /source/github/events/manual`) and `bootstrap/helpers/shared.php::generateGitManualWebhook()`. Deploy webhook format `/api/v1/deploy?uuid=<uuid>&force=false` confirmed from `generateDeployWebhook()`.
4. Firewall ports 22/80/443 (+8000/6001/6002 closable after dashboard domain) - confirmed verbatim.
5. API token permissions (`read`, `read:sensitive`, `write`, `deploy`, `root`), expirations, 3-255 char description, `Keys & Tokens -> API Tokens`, `Settings -> Configuration -> Advanced -> API Access` - confirmed verbatim. Base URL `/api/v1` and unauthenticated `/api/v1/health` (plus `/api/health`) confirmed.
6. Dockerfile `HEALTHCHECK` overriding the dashboard check for non-Compose Dockerfile apps, curl/wget must be in the image, Return Code/Response Text ignored, health-check Port defaulting to first Ports Exposes, "Without a health check, Coolify treats a successfully started container as ready" - all confirmed verbatim.
7. Dockerfile Location relative to Base Directory; 0.0.0.0 requirement; Domains comma-separated with `:port` and `/path` forms; Direction options; Inject Build Args toggle - confirmed.
8. Env-var UI flags (Build/Runtime Variable both default on, Multiline, Literal), Developer view semantics, Use Docker Build Secrets, Restart vs Redeploy, Volume Mount UI steps and UUID prefixing - confirmed.

**Changed:**
- Section 6 item 7 was WRONG: the OpenAPI spec on GitHub main DOES contain `GET/POST/PATCH /applications/{uuid}/storages` and `DELETE /applications/{uuid}/storages/{storage_uuid}` (plus `/backups` and `/backups/run`). Replaced with the real body (`type: persistent|file`, `name`, `mount_path` required, optional `host_path`).
- Section 6 item 6 uncertainty resolved: `POST /applications/{uuid}/envs` accepts `is_runtime`, `is_buildtime` and `comment` (controller allowlist), defaulting both flags to `true`; only the published doc body omits them. Bulk endpoint body must be wrapped as `{"data":[...]}`; single PATCH requires `key`+`value` and returns 201.
- Section 3: "Do not rely on PORT being set for Dockerfile builds" was wrong per the docs - Coolify sets `PORT` to the first exposed port and `HOST` to `0.0.0.0` unless you pre-set them. Kept the advice to set `ENV PORT=3000` anyway.
- Section 1b Ports Mappings: "bypasses the proxy" reworded - a host port mapping publishes the container port on the host in addition to the proxy route; the documented consequence is that rolling updates are disabled ("Both containers cannot bind the same host port").
- Section 1b Domains: the "sslip.io pre-fill" is not stated in the docs; reworded to the documented `Generate Domain` button using the server's wildcard domain.
- Section 1b Ports Exposes: the "pre-fills 3000" default is not documented; softened.
- Section 5: Auto Deploy path is `Configuration -> Advanced -> Deployment -> Auto Deploy` (docs). Webhooks page section/labels updated to current UI: section "Manual Git webhooks" with a per-provider "Webhook secret" field, section "Deploy webhook" with copy button "Deploy webhook URL" (old label "Deploy Webhook (auth required)" removed). GitHub content type may also be `application/x-www-form-urlencoded`.
- Section 4: added the documented minimums (interval/timeout >= 1 s, retries >= 1).
- Section 0: firewall wording aligned with docs (ufw-docker / Compose overrides as the alternative to a provider firewall).
- Section 6 item 2: token format `<id>|<secret>` flagged as a Sanctum convention, not documented.

**Could not verify (left as-is, listed in uncertainties):** the "write permission needs team admin/owner" claim; the exact volume name format `<uuid>-storage` (docs only say the name is prefixed with the resource UUID); whether the Coolify installed on the user's VPS is recent enough to have the storages endpoints and `is_buildtime` handling (verified against GitHub `main` on 2026-09-15, and issue #6847 shows the 422 on v4.0.0-beta.434); everything in section 7 (egress IP) and the Docker named-volume pre-population claim, which are outside Coolify's docs.

## Uncertainties
- Claims were verified against Coolify's GitHub `main` branch (openapi.yaml, ApplicationsController.php, routes, helpers) on 2026-09-15; an older Coolify version on the VPS may lack `/applications/{uuid}/storages` or the `is_buildtime`/`is_runtime` handling on POST /envs (issue #6847 shows the `is_build_time` 422 on v4.0.0-beta.434, but does not say when `is_buildtime` was added). Check `GET /api/v1/version` and the UI's OpenAPI page on the installed instance.
- The published OpenAPI/doc body for POST and PATCH /applications/{uuid}/envs omits `is_runtime`/`is_buildtime`/`comment`; acceptance was confirmed only from the controller source, not from a live call.
- Whether the `write` API permission additionally requires team admin/owner role was not found in the api-tokens doc text that was fetched.
- API token string format `<id>|<secret>` is a Laravel Sanctum convention; the docs only show `Authorization: Bearer <token>`.
- The exact Docker volume name (`<app-uuid>-storage`) is inferred; docs only say Coolify prefixes the Name with the resource UUID.
- Default value pre-filled in Ports Exposes (3000) and the default healthcheck interval/timeout/retries/start-period are not documented; read them off the screen.
- The 'sslip.io' temporary domain is a common fresh-install default but is not stated on the general configuration page, which only documents the `Generate Domain` button using the server's wildcard domain.
- Exact wording of the 'new resource' button varies between doc pages/versions ('+ New', 'Create New Resource', '+ Add Resource'); it is the same action. Tab names like 'Persistent Storage' vs older 'Storages' also depend on the Coolify version installed on the VPS.
- Outbound IP behaviour (section 7) is inferred from standard Docker MASQUERADE behaviour; Coolify docs do not state it explicitly. Whether the default `coolify` Docker network is IPv6-enabled was not verified - check with `docker network inspect coolify` and test with ipify from the app Terminal.
- Docker named-volume pre-population (copying the image directory's contents and ownership into a new empty named volume on first mount) is documented Docker behaviour but was not re-verified from docs.docker.com in this session; it only applies to a brand-new empty named volume, never to bind/directory mounts.
- How long the deployment job waits before declaring the new container unhealthy is not stated in the docs.
- better-sqlite3 prebuilt binaries: available for linux-x64 glibc (node:*-slim) in current releases; availability for musl/alpine and for very new Node majors was not verified - the Dockerfile keeps python3/make/g++ in the deps stage so a source build works either way.
- The GitHub issue #3440 on non-root volume ownership had no visible maintainer resolution at the time of fetching; the entrypoint-chown approach is the community-standard workaround, not an official Coolify recommendation.
- Whether 'Response Text' / 'Return Code' health-check fields are still ignored (docs say the generated check 'currently' uses only the exit status) may change in future Coolify versions.

## Sources
- https://raw.githubusercontent.com/coollabsio/coolify/main/openapi.yaml
- https://raw.githubusercontent.com/coollabsio/coolify/main/app/Http/Controllers/Api/ApplicationsController.php
- https://raw.githubusercontent.com/coollabsio/coolify/main/routes/webhooks.php
- https://raw.githubusercontent.com/coollabsio/coolify/main/app/Providers/RouteServiceProvider.php
- https://raw.githubusercontent.com/coollabsio/coolify/main/bootstrap/helpers/shared.php
- https://raw.githubusercontent.com/coollabsio/coolify/main/resources/views/livewire/project/shared/webhooks.blade.php
- https://raw.githubusercontent.com/coollabsio/coolify/main/app/Livewire/Project/Shared/Webhooks.php
- https://coolify.io/docs/api-reference/api/operations/create-public-application
- https://coolify.io/docs/api-reference/api/operations/deploy-by-tag-or-uuid
- https://coolify.io/docs/api-reference/api/operations/create-env-by-application-uuid
- https://coolify.io/docs/api-reference/api/operations/update-env-by-application-uuid
- https://coolify.io/docs/api-reference/api/operations/update-envs-by-application-uuid
- https://coolify.io/docs/api/overview
- https://coolify.io/docs/core/security/credentials/api-tokens
- https://coolify.io/docs/core/automation/deploy-webhooks
- https://coolify.io/docs/applications/deployments/manual-webhooks
- https://coolify.io/docs/knowledge-base/server/firewall
- https://coolify.io/docs/knowledge-base/health-checks
- https://coolify.io/docs/applications/configuration/health-checks
- https://coolify.io/docs/knowledge-base/rolling-updates
- https://coolify.io/docs/applications/build-packs/dockerfile
- https://coolify.io/docs/applications/configuration/general
- https://coolify.io/docs/applications/configuration/environment-variables
- https://coolify.io/docs/core/persistent-storage/storage-mounts/volume-mounts
- https://github.com/coollabsio/coolify/issues/6847
