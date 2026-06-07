# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

Please report security vulnerabilities privately via GitHub Security Advisories:

1. Go to the [Security tab](https://github.com/vitorvilaca3011/saros-proxy/security) of the repository
2. Click "Report a vulnerability"
3. Describe the issue in detail with steps to reproduce

**Do not disclose vulnerabilities publicly** until a fix has been released and a reasonable period has passed for users to update.

You can expect:
- **Initial response:** within 48 hours
- **Status updates:** at least every 5 business days
- **Resolution target:** within 30 days (sooner for critical issues)

## Security Model

### What this proxy protects against

- **API key exposure** — keys are masked in logs (first 4 + last 4 chars)
- **Server-Side Request Forgery (SSRF)** — only HTTPS upstream URLs are accepted
- **Path traversal** — request paths containing `..` are rejected
- **Unauthorized access** — configurable CORS origin whitelist
- **Brute-force/DoS** — rate limiting via `hono-rate-limiter`
- **Data-at-rest exposure** — AES-256-GCM encryption for API keys in config files
- **Network sniffing** — HTTPS-only upstream connections

### What this proxy does NOT protect against

- **Authentication to the proxy itself** — anyone who can reach the proxy port can use it. Bind to `127.0.0.1` in production.
- **Man-in-the-middle between client and proxy** — the proxy listens on plain HTTP. Run behind a reverse proxy with TLS for production deployments.
- **Compromised host** — if an attacker has access to the host running the proxy, they can read config files and environment variables.
- **Upstream API issues** — the proxy passes through upstream errors transparently.

## Best Practices

### 1. Bind to localhost

```yaml
host: 127.0.0.1  # Default — only accessible from the same machine
```

Only bind to `0.0.0.0` if you know what you're doing and have firewall rules in place.

### 2. Encrypt API keys at rest

```bash
npm run setup
# Choose "Yes" when prompted to encrypt keys
# Use a strong master key (at least 16 characters, mixed case + numbers + symbols)
export OPENCODE_GO_ENCRYPTION_KEY="your-strong-master-key"
```

### 3. Use a reverse proxy with TLS for production

```nginx
# Example nginx configuration
server {
    listen 443 ssl;
    server_name proxy.example.com;

    ssl_certificate     /etc/ssl/certs/proxy.crt;
    ssl_certificate_key /etc/ssl/private/proxy.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

### 4. Restrict CORS origins

```yaml
allowedOrigins:
  - http://localhost:5173   # Your frontend dev server
  - http://127.0.0.1:5173
  # DO NOT use [] (allow all) in production
```

### 5. Keep dependencies updated

```bash
npm audit
npm update
```

## Architecture Security Features

| Feature | Implementation | File |
|---------|---------------|------|
| Key masking in logs | First 4 + last 4 chars, replaced with `...` | `src/logger.ts` |
| HTTPS-only upstream | URL scheme validation | `src/validation.ts` |
| Path traversal prevention | Rejects `..` in paths | `src/proxy-logic.ts` |
| Hop-by-hop header stripping | Removes Connection/Transfer-Encoding/Keep-Alive etc. | `src/proxy.ts` |
| Request timeout | Configurable, default 30s | `src/proxy.ts` |
| Body size limit | 10MB max | `src/proxy.ts` |
| Rate limiting | Configurable IP-based | `src/proxy.ts` |
| CORS origin validation | Regex-based whitelist matching | `src/proxy.ts` |
| Key encryption at rest | AES-256-GCM + scrypt (N=16384) | `src/key-encryption.ts` |
| Graceful shutdown | SIGINT/SIGTERM, active request draining | `src/index.ts` |
