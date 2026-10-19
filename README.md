# Orca Native Push

Orca desktop plugin that sends agent **needs input** / **finished** alerts to
[Orca Native](https://github.com/zhigang1992/orca-native) through a Cloudflare
APNs relay, so the phone still gets them when the app is killed.

## Install (Orca marketplace)

1. Orca → Plugins → Marketplace sources
2. Git URL: `https://github.com/zhigang1992/orca-native-push.git`
3. Git ref: `main`
4. Add source → install **Orca Native Push** from the catalog

## After install

Command Palette → **Native Push: Show credentials**, open the link on the phone,
then Settings → Notifications → Delivery: **Push from my Mac**.

## Develop

Canonical copy lives in the private `orca-native` repo under `plugin/orca-native-push/`.
This public repo is a mirror for marketplace installs only.
