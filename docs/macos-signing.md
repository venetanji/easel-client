# macOS signing and notarization

Easel uses the same Developer ID Application certificate as Tetrilaunch. A
certificate belongs to the Apple developer team and can sign multiple apps.
Easel retains its own bundle ID, `org.ait4x.easelclient`.

## GitHub credentials

Configure these secrets in **easel-client > Settings > Environments >
desktop-build**. GitHub environments belong to individual repositories;
Tetrilaunch's environment does not automatically share its secrets with Easel.

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE` | Base64 of the Developer ID Application `.p12`, including its private key |
| `MACOS_CERTIFICATE_PASSWORD` | The `.p12` export password |
| `MACOS_SIGNING_IDENTITY` | Certificate common name without the `Developer ID Application:` prefix |
| `ASC_API_KEY_P8` | Base64 of the App Store Connect API `.p8` key |
| `ASC_API_KEY_ID` | The API key's ID |
| `ASC_API_ISSUER_ID` | The issuer UUID from App Store Connect > Users and Access > Integrations > App Store Connect API |

Upload secret values through the GitHub environment UI or `gh secret set
--repo venetanji/easel-client --env desktop-build`. Keep certificate files,
private keys and passwords outside this repository.

## Build behavior

- Pull requests use `desktop-checks` and package without release credentials.
- Tag, published-release and manual workflow runs use `desktop-build` for the
  macOS job. All six secrets are required; missing credentials fail the build.
- Local and PR macOS builds use ad hoc signatures. They are not notarized.
  Ad hoc signing is necessary to run ARM64 apps and provides no developer identity.
- Release builds require the Developer ID identity, enable the hardened runtime,
  and notarize the app before creating its ZIP and DMG. The DMG is also signed,
  notarized and stapled. Signature, ticket and Gatekeeper checks must succeed
  before uploading artifacts or publishing a release.
- Entitlements allow Electron's JIT, microphone and camera access. Device access
  still requires OS permission and Easel's user consent.
- The notarization key is decoded into a private temporary file and removed on
  completion. The workflow uses API key authentication, not Apple ID passwords.

Run **Desktop Builds > Run workflow** on the signing branch to build signed
artifacts without publishing a release. Once merged, future version tags use
the same signing path. Existing releases are not retroactively signed; their
artifacts must be explicitly replaced or a new version released.
