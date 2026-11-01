# Releasing Gofer

One-time setup (about an hour of your time, plus a few days waiting on identity checks), then every release is: bump the version, push a tag.

Start step 2 first. It's the one with a waiting period.

---

## 1. GitHub repository (15 minutes)

1. Create a **public** repository, e.g. `gofer`. It has to be public for updates: installed copies check its Releases page without logging in. (If you want the code private, make a second public repo just for releases and point `repository` at that.)
2. Put the repository URL in `package.json`:
   ```json
   "repository": { "type": "git", "url": "https://github.com/<you>/gofer.git" }
   ```
3. Push this folder to it (`model/`, `node_modules/`, `release/` are ignored).
4. **Settings › Pages** › Source: *Deploy from a branch* › Branch `main`, folder `/docs`. Your privacy policy is then at `https://<you>.github.io/gofer/privacy.html`. Put your contact email in `docs/privacy.html` first.
5. Watch the first run under **Actions**. It builds unsigned, runs the tests and smoke test, and uploads a `model-lock` artifact. Download `model.lock.json` from it, commit it to the repo root. From then on every build uses exactly that model and fails if the bytes differ.

## 2. Code signing: Azure Artifact Signing (~$9.99/month)

Individual developers are eligible in the US and Canada. The identity check takes from a few hours to a few days.

1. Create an Azure account and a pay-as-you-go subscription at portal.azure.com.
2. Subscription › **Resource providers** › register `Microsoft.CodeSigning`.
3. Create an **Artifact Signing account** (search "Artifact Signing" or "Trusted Signing"). Pick a region near you (e.g. East US) and the Basic tier. Note the account name and the **Account URI** shown on its overview page (e.g. `https://eus.codesigning.azure.net/`).
4. In the account: **Identity validation** › New › *Public* › *Individual*. Complete the verification with your legal name. Wait for "Completed".
5. **Certificate profiles** › Create › *Public Trust*, using that validated identity. Note the profile name.
6. Microsoft Entra ID › **App registrations** › New registration (e.g. `gofer-signing`). Note its *Application (client) ID* and *Directory (tenant) ID*. Under **Certificates & secrets** create a client secret and copy its value.
7. Back on the signing account › **Access control (IAM)** › Add role assignment › the *Certificate Profile Signer* role (older docs call it "Trusted Signing Certificate Profile Signer") › assign it to the `gofer-signing` app.
8. In GitHub › Settings › Secrets and variables › Actions:
   - **Secrets:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
   - **Variables:** `AZURE_SIGNING_ENDPOINT` (the Account URI), `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_PUBLISHER` (your name exactly as it appears on the certificate)

The next pipeline run signs `Gofer.exe` and the installer, and fails the build if either signature isn't valid.

What to expect: signed downloads can still show "Windows protected your PC" for the first releases. The warning fades as people install signed versions under the same identity. Keep signing every release with the same account so that reputation carries over.

## 3. Microsoft Store (no SmartScreen warning at all)

1. Create a developer account at partner.microsoft.com (individual). Check the current registration fee on the sign-up page.
2. Create a new app and **reserve the name**. "Gofer" may well be taken; have a second choice ready (e.g. "Gofer — File Fetcher"). If you change it, set `productName` in `tools/build-win.js` to match.
3. Open **Product identity** and copy three values into GitHub Variables:
   - `STORE_IDENTITY_NAME` ← *Package/Identity/Name*
   - `STORE_PUBLISHER` ← *Package/Identity/Publisher* (starts with `CN=`)
   - `STORE_PUBLISHER_DISPLAY_NAME` ← *Package/Properties/PublisherDisplayName*
4. Push a tag (below). The run produces `Gofer-x.y.z-store.appx` in its artifacts. The Store signs it, so it doesn't need your certificate.
5. Start a submission:
   - **Packages:** upload the `.appx`.
   - **Privacy policy URL:** the GitHub Pages link from step 1.
   - **Age rating:** complete the questionnaire. Gofer has no user-generated content or communication, so expect the lowest rating.
   - **Restricted capability `runFullTrust`:** you'll be asked why. Answer: *"Gofer is a desktop companion that indexes the user's own documents locally and reads the active window title and cursor text through Windows UI Automation to find related files. All processing is on-device."*
   - **Store listing:** description, at least one screenshot (1366×768 or larger), and the search terms.
6. Certification usually takes one to three business days. The Store build starts with Windows through a startup task, which users can turn off in Task Manager › Startup apps, and the Store delivers its updates.

## 4. Cutting a release

```bash
npm version 0.3.0 --no-git-tag-version   # or edit package.json
git commit -am "Gofer 0.3.0"
git tag v0.3.0
git push && git push --tags
```

The pipeline then:
- checks the tag matches `package.json`
- fetches the pinned model and verifies it
- runs the engine tests and the ranking quality gate (top-1 must stay ≥ 0.85)
- builds and signs the installer and portable zip
- smoke-tests the packaged app
- checks the signatures
- publishes the GitHub Release, which installed copies pick up within six hours
- builds the Store package

Before the **first** public release, also go through `docs/test-checklist.md` on your own PC.

## Costs at a glance

| Item | Cost |
|---|---|
| GitHub (public repo, Actions, Releases, Pages) | free |
| Azure Artifact Signing | about $9.99/month |
| Microsoft Store developer account | check current fee at sign-up |
