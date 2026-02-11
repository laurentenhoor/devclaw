# Publishing DevClaw to npm

## Package Details

- **Name:** `@laurentenhoor/devclaw`
- **npm Profile:** https://www.npmjs.com/settings/laurentenhoor/packages
- **Package URL:** https://www.npmjs.com/package/@laurentenhoor/devclaw

## Prerequisites

1. **NPM Access Token** is configured as `NPM_ACCESS_TOKEN` secret in GitHub repository settings
2. **npm account:** laurentenhoor
3. **Node.js 20+** installed locally for testing

## Publishing Methods

### Method 1: Automated (Recommended)

Publishing happens automatically via GitHub Actions when a release is created:

1. **Create a new release** on GitHub:
   ```bash
   # Tag format: v{version} (e.g., v0.1.0)
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. **Create GitHub Release:**
   - Go to: https://github.com/laurentenhoor/devclaw/releases/new
   - Choose the tag you just pushed
   - Write release notes
   - Click "Publish release"

3. **Monitor the workflow:**
   - GitHub Actions will automatically build and publish to npm
   - Check: https://github.com/laurentenhoor/devclaw/actions

### Method 2: Manual Workflow Trigger

Trigger the workflow manually from GitHub Actions:

1. Go to: https://github.com/laurentenhoor/devclaw/actions/workflows/npm-publish.yml
2. Click "Run workflow"
3. Enter the tag name (e.g., `v0.1.0`)
4. Click "Run workflow"

### Method 3: Local Publishing (Not Recommended)

For testing or emergencies only:

1. **Login to npm:**
   ```bash
   npm login
   # Username: laurentenhoor
   # Password: <your-password>
   # Email: <your-email>
   ```

2. **Test the package:**
   ```bash
   npm install
   npm run build
   npm pack --dry-run
   ```

3. **Publish:**
   ```bash
   npm publish --provenance --access public
   ```

## Testing Before Publishing

### Dry Run Test

```bash
# Install dependencies
npm install

# Build the package
npm run build

# Check what will be included
npm pack --dry-run

# This will show:
# - Package size
# - Files that will be included
# - Tarball contents
```

### Verify Package Contents

```bash
# Create a tarball locally
npm pack

# Extract and inspect
tar -xzf openclaw-devclaw-0.1.0.tgz
ls -la package/
```

### Expected Package Contents

The published package should include:
- `dist/` - Compiled JavaScript files
- `roles/` - Default role templates
- `docs/` - Documentation files  
- `package.json` - Package metadata
- `README.md` - Package documentation
- `.npmignore` - Publish exclusions

The package should **NOT** include:
- `*.ts` source files (except `.d.ts`)
- `node_modules/`
- `.git/`
- `tsconfig.json`
- Development files

## Version Management

### Bumping Version

Before creating a release, update the version in `package.json`:

```bash
# Patch release (0.1.0 -> 0.1.1)
npm version patch

# Minor release (0.1.0 -> 0.2.0)
npm version minor

# Major release (0.1.0 -> 1.0.0)
npm version major
```

This automatically:
- Updates `package.json`
- Creates a git commit
- Creates a git tag

Then push:
```bash
git push && git push --tags
```

## Verifying Publication

After publishing, verify:

1. **Package appears on npm:**
   - https://www.npmjs.com/package/@laurentenhoor/devclaw

2. **Test installation:**
   ```bash
   # In a temporary directory
   mkdir test-install && cd test-install
   npm install @laurentenhoor/devclaw
   ```

3. **Check package contents:**
   ```bash
   ls -la node_modules/@laurentenhoor/devclaw/
   ```

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
rm -rf dist/ node_modules/
npm install
npm run build
```

### Publish Fails - Already Published

If the version already exists on npm, you need to bump the version:

```bash
npm version patch  # or minor/major
git push && git push --tags
```

### Publish Fails - Authentication

Check that `NPM_ACCESS_TOKEN` secret is correctly set in GitHub:
- Go to: https://github.com/laurentenhoor/devclaw/settings/secrets/actions
- Verify `NPM_ACCESS_TOKEN` exists and is valid

Generate a new token if needed:
- https://www.npmjs.com/settings/laurentenhoor/tokens
- Token type: "Automation" (for CI/CD)
- Copy token and update GitHub secret

### Provenance Fails

If `--provenance` fails:
- Ensure `id-token: write` permission is set in workflow
- Check that GitHub Actions is enabled
- Verify repository settings allow provenance

## Post-Publishing Checklist

- [ ] Verify package appears on npm
- [ ] Test installation in a fresh project
- [ ] Update CHANGELOG.md with release notes
- [ ] Announce release in project channels
- [ ] Close related issues/PRs
- [ ] Update documentation if needed

## Support

For issues with publishing:
- Check GitHub Actions logs
- Review npm publish documentation
- Contact package maintainer: laurentenhoor
