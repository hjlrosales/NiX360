# HTTPS and reverse-proxy setup

Status: the application's cookie, CSRF and forwarded-header behaviour is **verified locally**, including a real self-signed TLS terminator proxying to Fastify (`server/tests/proxy.test.ts`). A DSM reverse proxy, certificate issuance/renewal, an external route and throughput have **not** been configured or tested.

## Topology

```text
Browser --HTTPS--> DSM reverse proxy or Nginx --HTTP 127.0.0.1:8787--> app container
```

The application does not terminate public TLS itself. Compose publishes port 8787 on `127.0.0.1` only; keep that binding. `NIX_TRUST_PROXY=true` makes the app believe `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`. A client that can reach the app port directly could spoof those headers, which is why the port must stay on loopback or a proxy-only network.

## Application settings

| Setting | Value | Why |
|---|---|---|
| `NIX_PUBLIC_ORIGIN` | Exact external origin, e.g. `https://nix.example.com` | CSRF checks compare the `Origin` header to this value. No path, no trailing slash. |
| `NIX_COOKIE_SECURE` | `true` | Session cookies are `HttpOnly; Secure; SameSite=Strict`; plain HTTP cannot keep a session. |
| `NIX_TRUST_PROXY` | `true` | Honour the proxy's forwarded protocol and client address. Only enable behind the trusted proxy. |
| `NIX_HOST` | `127.0.0.1` (default) or the container interface | Inside Compose the app must listen on its container interface; only the host-side publish stays loopback. |

If `NIX_PUBLIC_ORIGIN` is unset, the CSRF origin is derived from the request's protocol and `Host` header, so the proxy must preserve `Host` and send `X-Forwarded-Proto`. Setting `NIX_PUBLIC_ORIGIN` removes that dependency and is recommended.

The application sends `Strict-Transport-Security` through Helmet. Do not add a second HSTS header at the proxy.

## Nginx example

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name nix.example.com;

    ssl_certificate     /etc/nginx/certs/nix.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/nix.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # The API body limit is 64 KiB; this is only headroom.
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Stream media instead of buffering whole videos in the proxy.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name nix.example.com;
    return 301 https://$host$request_uri;
}
```

Range requests pass through as normal proxied requests; the application answers `206`/`416` itself, so no special proxy module is required.

## DSM reverse proxy (outline, unverified)

1. Control Panel → Login Portal → Advanced → Reverse Proxy → Create.
2. Source: HTTPS, the external hostname, port 443.
3. Destination: HTTP, `localhost`, port 8787.
4. Attach the existing certificate for the hostname.
5. Confirm the proxy forwards `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. DSM versions differ here; if the protocol header is absent, keep `NIX_PUBLIC_ORIGIN` set so CSRF does not depend on it.
6. Publish only the application vhost. Keep DSM administration, SSH, SMB and Container Manager off the public route.

DSM's exact header behaviour, certificate renewal and firewall rules have not been checked on the NAS.

## Verification checklist

- `curl -sS -D- https://nix.example.com/api/health -o /dev/null` → `200`, `Strict-Transport-Security` present.
- Sign in in a browser: the session cookie shows `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`.
- A state-changing request with a foreign `Origin` returns `403 csrf_origin_rejected`.
- `curl` with a valid session and `Range: bytes=0-1023` on a media URL returns `206`.
- The app port is unreachable from another LAN host, and the DSM UI is not served on the application hostname.
- Reloading over HTTPS keeps the session; requesting `http://` does not (Secure cookie).

## Local verification performed

`server/tests/proxy.test.ts` covers three cases:

1. With `NIX_TRUST_PROXY=false`, a spoofed `X-Forwarded-Proto: https` does not change CSRF's expected origin.
2. With trust enabled, the forwarded scheme is honoured, `Secure` cookies are issued, and the same request without the header is rejected as cross-origin.
3. A self-signed certificate (generated with OpenSSL, skipped when unavailable) and a local HTTPS terminator proxy to the app: health, HSTS, login cookie attributes and an authenticated session all work through real TLS.

Verified 2026-11-05 with OpenSSL 3.5.6 on Windows and the full suite (65 tests, 63 passed, 2 skipped).

## Remaining work

DSM/Nginx deployment, real certificate issuance and renewal, external reachability, HTTP/2 behaviour, long playback and Range traffic over a remote connection, and measured throughput remain open. Those require NAS/network authorization and are Phase 6 gates.
