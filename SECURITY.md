# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities via GitHub's private vulnerability reporting or email security@parashield-protocol.com.

**Do NOT open public issues for security vulnerabilities.**

## PR Review Checklist (for maintainers)

Before merging any PR, verify:

### Red Flags — Reject Immediately
- [ ] New dependencies added without justification
- [ ] Changes to CI/CD workflows (`.github/workflows/`)
- [ ] Install scripts (`postinstall`, `preinstall` hooks)
- [ ] Obfuscated code (base64, eval, Function constructor)
- [ ] Network calls to unknown domains
- [ ] Access to `.env` or `process.env` in unexpected places
- [ ] Modified lock files with many new packages

### Required Checks
- [ ] PR description explains the change clearly
- [ ] Code is readable and follows project patterns
- [ ] No suspicious or unexplained code
- [ ] Tests are included (if applicable)
- [ ] Author has a reasonable contribution history

### High-Risk Files to Scrutinize
```
.github/workflows/*.yml
package.json (new dependencies)
Cargo.toml
lock files
*.sh (shell scripts)
entrypoint scripts
```

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✓         |

## Security Features Enabled
- Branch protection (requires 1 approval)
- Stale review dismissal
- Vulnerability alerts
- Automated security fixes
