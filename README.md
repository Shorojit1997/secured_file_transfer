# Secure File Transfer

A TypeScript monorepo: a Vite/React client and an Express API server that let an
authenticated sender upload a file, encrypted end-to-end in the browser, and
share a link for one recipient to download it. The server stores only
ciphertext — see [`plan.md`](plan.md) for the full design and
[`docs/CRYPTO_PROTOCOL.md`](docs/CRYPTO_PROTOCOL.md) once the crypto core lands.

## Requirements

- Node `>=22.12.0` (`.nvmrc` pins the version used here: 24)
- Yarn 1.22 (workspaces)
- Docker, for PostgreSQL and Redis locally and for the full containerized stack

## Getting started

```bash
yarn install
cp .env.example .env         # optional; every value has a sane local default
docker compose up -d postgres redis
yarn dev                     # builds shared/, then client on :5100, server on :3000
```

Migrations run automatically at server boot. Open <http://localhost:5100> and
sign up — with `RESEND_API_KEY` and `SMTP_URL` both unset, verification and
reset emails are written to `var/mail/*.eml` instead of sent.

To run everything in containers instead, see [Docker](#docker).

## Layout

```
.
├── shared/                 # protocol code used by both client and server
│   └── src/
├── client/                 # Vite + React + TypeScript
│   ├── src/
│   ├── tsconfig.app.json   # browser sources
│   └── tsconfig.node.json  # vite.config.ts
├── server/                 # Express + TypeScript (Node ESM)
│   └── src/
│       ├── app.ts          # app assembly — mount middleware and routers here
│       ├── index.ts        # process entry: migrate, listen, graceful shutdown
│       ├── config/env.ts   # zod-validated environment, parsed once at boot
│       ├── auth/           # sessions, passwords, one-time tokens, mailer
│       ├── crypto/         # server-side primitives: hashing, field encryption
│       ├── db/             # drizzle schema, client, migrations
│       ├── storage/        # blob store (local filesystem behind an interface)
│       ├── audit/          # append-only audit log
│       ├── jobs/           # BullMQ queues and workers: mail, janitor
│       ├── middleware/
│       └── routes/
├── docker-compose.yml       # full stack: postgres, redis, mailpit, server, client
├── docker-compose.dev.yml   # overlay: bind-mounted sources, HMR
├── eslint.config.js         # one flat config for all three workspaces
└── .prettierrc.json
```

`app.ts` is kept separate from `index.ts` so tests can mount the app (e.g. with
`supertest`) without binding a port.

### The `shared` workspace

`shared/` holds code both sides need to agree on byte-for-byte (cookie names,
and eventually the `SFT1` wire format and crypto). It has a real build step:
`package.json` resolves to `dist/`, not `src/`, because the compiled production
server runs under plain `node`, which — unlike `tsx` in dev or Vite in the
client — does not remap a workspace package's own internal `./foo.js` imports
back to `./foo.ts` when the package resolves straight to source. `yarn dev`
and `yarn build` both build `shared` first; if you change something in
`shared/src` and don't see it take effect, rebuild it
(`yarn workspace shared build`).

## Scripts

Run from the repo root.

| Script                              | What it does                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| `yarn dev`                          | Build `shared`, then both dev servers with HMR               |
| `yarn dev:devtools`                 | Standalone React DevTools; the dev server auto-connects      |
| `yarn build`                        | Build `shared`, then type-check and build the rest           |
| `yarn start`                        | Run the built server                                         |
| `yarn test`                         | `node --test` over server and shared, then Vitest for client |
| `yarn lint`                         | ESLint across the repo; warnings fail the run                |
| `yarn lint:fix`                     | ESLint with autofix                                          |
| `yarn format`                       | Prettier write                                               |
| `yarn format:check`                 | Prettier check                                               |
| `yarn typecheck`                    | `tsc --noEmit` in every workspace                            |
| `yarn run check`                    | format:check + lint + typecheck, in one go                   |
| `yarn workspace server db:generate` | Generate a migration from `db/schema` changes                |
| `yarn workspace server db:migrate`  | Apply pending migrations without starting the server         |

Target a single workspace with `yarn workspace <name> <script>`, e.g.
`yarn workspace client build`.

### React DevTools

`yarn dev:devtools` opens the standalone inspector on port 8097. The Vite dev
server injects `<script src="http://localhost:8097">` ahead of the React runtime
so the app connects on load; start it before or after the client, then reload the
page. The plugin is `apply: 'serve'`, so `vite build` never emits the tag and
production has no bridge to connect to. Order matters — the script has to run
before React does, which is why it is injected rather than imported from
`main.tsx`.

Nothing to expose when the dev stack runs in Docker: the tag is fetched by your
browser, so `localhost:8097` is your machine, not the container. Without the
inspector running the request is refused and logged in the console, which is
harmless. The browser extension needs none of this and still works on its own.

## Background jobs

Anything a request should not wait for runs as a [BullMQ](https://docs.bullmq.io)
job on Redis, so a slow SMTP handshake never delays a response and a failed
delivery is retried instead of lost. `server/src/jobs/queues.ts` declares the
queues and the producer functions; `server/src/jobs/workers.ts` starts the
workers, which `index.ts` boots before the server listens and closes on
`SIGTERM` after in-flight requests finish.

| Queue         | Job         | Producer                                  |
| ------------- | ----------- | ----------------------------------------- |
| `mail`        | `send-mail` | `enqueueMail` — signup and password reset |
| `maintenance` | `janitor`   | a repeatable scheduler, every 15 minutes  |

Jobs get five attempts with exponential backoff from 30 seconds, and completed
and failed jobs are trimmed so the keyspace stays bounded. Failures are logged
once per attempt by the `failed` listener in `workers.ts` — the job payload is
never logged, because a mail job holds a recipient address.

Verification and reset mail is therefore sent _after_ the `202` response. The
signup route still awaits `enqueueMail`, because handing the job to Redis is the
part that must not be lost: the queue connection sets `skipWaitingForReady` with
a five second `commandTimeout`, so an unreachable Redis fails the request
quickly rather than hanging it. Worker connections need
`maxRetriesPerRequest: null` for their blocking reads, which is why the two
connections are configured separately.

Moving the janitor from `setInterval` onto a queue also makes it safe to run
more than one server: a repeatable job is claimed by a single worker, so the
purge no longer races with itself across instances.

## Docker

`docker compose up --build` runs the whole application: nginx serving the built
SPA and reverse-proxying `/api`, the compiled Express server, PostgreSQL, Redis
for the job queues, and [Mailpit](https://mailpit.axllent.org/) as a local mail
sink.

```bash
cp .env.example .env
openssl rand -base64 32   # FIELD_ENCRYPTION_KEY
openssl rand -base64 32   # EMAIL_LOOKUP_PEPPER
docker compose up --build -d
```

| Address                 | What                                |
| ----------------------- | ----------------------------------- |
| <http://localhost:8080> | The application (`APP_PORT`)        |
| <http://localhost:8025> | Mailpit, for verification links     |
| `localhost:5433`        | PostgreSQL, also used by `yarn dev` |
| `localhost:6380`        | Redis, also used by `yarn dev`      |

The stack runs `NODE_ENV=production`, which is the point: it exercises the
production CSP, `__Host-` cookie prefixes, and `Secure` cookies, and it
refuses to boot without `FIELD_ENCRYPTION_KEY`, `EMAIL_LOOKUP_PEPPER`, and an
SMTP URL. Two consequences worth knowing:

- Because the cookies are `Secure`, use Chrome or Firefox, which accept them on
  `http://localhost`. Safari does not, and needs TLS in front.
- `APP_ORIGIN` is the one origin the server trusts — CORS, the CSRF `Origin`
  check in `middleware/csrf.ts`, and the links in outgoing mail all read it. It
  defaults to `http://localhost:${APP_PORT}` in this stack, so set it in `.env`
  only for a real domain or a changed `APP_PORT`. `config/env.ts` reduces
  whatever it is given to scheme, host, and port, because that is all a browser
  ever puts in an `Origin` header — a trailing slash or a path is discarded
  rather than silently failing every comparison.

Ciphertext chunks live on the `blob-data` volume at `/data/blobs`; the database
lives on `postgres-data`, and the queues on `redis-data`. All three survive
`docker compose down`, and `down -v` deletes them.

nginx terminates the browser connection, so `client/nginx.conf.template` — not
helmet — sets the security headers on the HTML document. Its CSP directives are a copy of
`productionCsp` in `server/src/middleware/security-headers.ts` and the two must
be changed together. `client_max_body_size` there is likewise sized for
`MAX_CHUNK_BYTES` plus the GCM tag; raising the chunk size means raising both.

### Hot reload in containers

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The overlay stops at each image's `build` stage, bind-mounts `shared/`,
`server/`, and `client/`, and runs `tsx watch` and Vite on <http://localhost:5100>
with `NODE_ENV=development`. `node_modules` stays in named volumes so the
container's Linux binaries are not shadowed by a host install — `@node-rs/argon2`
and the Rolldown bindings are platform-specific. Those volumes are seeded once
from the image, so after changing a dependency, rebuild and recreate them:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -V`.

Run the overlay from the host: bind mount paths resolve against the Docker host,
so it does not work from inside the devcontainer, whose only reliable option is
the volume-only production stack.

### Deploying

Images build for the host architecture. For an amd64 target from an Apple
Silicon machine:

```bash
docker buildx build --platform linux/amd64 -f server/Dockerfile .
docker buildx build --platform linux/amd64 -f client/Dockerfile .
```

Both Dockerfiles take the repository root as their build context — they need
`yarn.lock` and `shared/`. Put TLS termination in front of the `client`
container, keep `TRUSTED_PROXY_HOPS` equal to the number of proxies ahead of the
server, and point mail at a real provider.

Mail goes out through Resend over HTTPS when `RESEND_API_KEY` is set, and over
SMTP through `SMTP_URL` otherwise. Prefer Resend on hosts that block outbound
SMTP ports — Render, Fly, and Heroku all do — and set `MAIL_FROM` to an address
on a domain verified in the Resend dashboard, or every send is rejected with a 403.

The server writes ciphertext chunks as the unprivileged `node` user, so whatever
is mounted at `BLOB_ROOT` has to belong to it. A Docker named volume inherits
the image's ownership the first time it is used, which is why the Compose stack
needs nothing; a cloud provider's attached disk is mounted empty and owned by
`root`, and shadows whatever the image put there. `server/docker-entrypoint.sh`
covers both: it starts as root only long enough to create and `chown` the blob
root, then drops to `node` through `setpriv` before exec'ing the process.

#### Two services on separate hosts

The browser only ever calls `/api` on its own origin, so the `client` container
proxies `/api/` to the server for every deployment shape. `API_PROXY_TARGET`
names that upstream and defaults to `http://server:3000`, the Compose service.
Split the two across hosts — Render, Fly, two Kubernetes services — and the
`client` container needs the server's own URL instead:

```
API_PROXY_TARGET=https://secured-server.onrender.com
```

`client/docker-entrypoint.d/15-api-proxy-target.envsh` reads it at container
start, derives the upstream `Host` header and TLS server name from it, takes the
DNS resolver from `/etc/resolv.conf`, and listens on `PORT` when the platform
sets one. Leaving `API_PROXY_TARGET` unset on a split deployment leaves nginx
pointed at a `server` host that does not exist there, and every `/api` call
answers `502`.

The server still needs `APP_ORIGIN` set to the **client's** public URL, not its
own: that is the origin the browser sends, and CORS, the CSRF `Origin` check,
and outgoing mail links all read it. `TRUSTED_PROXY_HOPS` counts every proxy
ahead of the server — the platform's edge in front of the client container, the
client container's nginx, and the platform's edge in front of the server itself.

## Linting and formatting

The split is the conventional one: **Prettier owns formatting, ESLint owns
correctness.** `eslint-config-prettier` is applied last in the flat config, so
ESLint never reports a rule the formatter would just rewrite.

`eslint.config.js` layers, general to specific:

1. **Baseline** — `@eslint/js` recommended, import sorting
   (`simple-import-sort`), a few unambiguous correctness rules, and the two
   house rules: `local/no-comments` (a local rule rejecting every prose
   comment, so code must explain itself through names and types; machine
   directives such as `eslint-disable` and `@ts-expect-error` are exempt) and
   size limits — `max-lines` 300 per file, `max-lines-per-function` 60,
   `max-depth` 3, `complexity` 10, `max-params` 4.
2. **TypeScript** — `strictTypeChecked` + `stylisticTypeChecked` with
   type-aware linting via `projectService`, which resolves each file against
   its nearest `tsconfig.json`. This catches real bugs (floating promises,
   unsafe `any` flow, non-exhaustive switches) that syntax-only linting cannot.
3. **Client** — `eslint-plugin-react` (with the JSX runtime config, so no
   `import React`), `react-hooks`, `react-refresh`, and `jsx-a11y` for
   accessibility. `react/prop-types` is off; TypeScript already does that job.
4. **Server** — Node globals, and `no-console` allowed since the server logs to
   stdout by design.
5. **Plain JS** — type-aware rules disabled for config files outside any
   `tsconfig`.

Unused variables are allowed when prefixed `_`, which is what makes Express's
arity-based error middleware (`(err, _req, res, _next)`) lint clean.

Because comments are a lint error everywhere, reasoning that needs prose lives in
this README, in `docs/`, or in a pull request description — reviewed places that
cannot silently drift away from the code they describe.

### ESLint version

Held at ESLint 9 even though 10 is released: `eslint-plugin-react` and
`eslint-plugin-jsx-a11y` still declare peer support only up to `^9`. Upgrading
today would mean dropping accessibility linting. Revisit once both ship v10
support.

## Type safety

Both workspaces run `strict` plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, and `erasableSyntaxOnly`.

`erasableSyntaxOnly` forbids TypeScript syntax that emits runtime code
(`enum`, constructor parameter properties, namespaces), which keeps the sources
strippable by Node's native TypeScript support and by any esbuild-based
transform. If you hit `TS1294`, that is the rule — use a plain field
assignment or a `const` object instead.

Server relative imports carry a `.js` extension. That is required by Node ESM
with `"module": "nodenext"`; the extension refers to the emitted file.

## Environment

`server/src/config/env.ts` validates `process.env` with zod at boot, so a
missing or malformed variable fails immediately instead of surfacing as
`undefined` inside a request handler. Add new variables to that schema and to
`.env.example`. Never commit `.env` — `.gitignore` excludes it.

`.env.example` is grouped into three lists: **Backend** (the zod schema above),
**Frontend** (`CLIENT_PORT` and `API_PROXY_TARGET`, read by
`client/vite.config.ts` for the dev server only — the app calls `/api` on its own
origin, so there are no `VITE_` variables and nothing is inlined into the
bundle), and **Docker Compose only** (`APP_PORT`, `MAILPIT_UI_PORT`,
`REDIS_PORT`).

The browser-facing origin is a single variable, `APP_ORIGIN`. Left unset it
defaults per stack — `http://localhost:5100` for `yarn dev`,
`http://localhost:8080` for `docker compose up` — so it needs a value only for a
real domain or a changed `CLIENT_PORT`/`APP_PORT`.

`FIELD_ENCRYPTION_KEY` and `EMAIL_LOOKUP_PEPPER` have insecure local defaults
and are required whenever `NODE_ENV=production`, as is a mail transport — either
`RESEND_API_KEY` or `SMTP_URL`. Boot fails immediately if one is missing.

## Not included yet

File upload and download, transfer management, and the `SFT1` end-to-end
encryption protocol itself — see `plan.md` for the phased build order. Also out
of scope for this repo: object storage adapters, orchestration beyond Compose,
and virus scanning (deliberately incompatible with zero-knowledge storage — see
`plan.md` §2).
