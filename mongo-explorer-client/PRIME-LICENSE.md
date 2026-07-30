# PrimeNG / PrimeUI licence

**Why there's a banner in the corner:** PrimeNG 22 is no longer MIT. As of v22 it ships under the
**PrimeUI licence** — a dual Community (free) / Commercial (paid) model — and it requires a licence
key. Without one it draws an "Invalid PrimeUI License" notice on every page.

The package's own terms are in
[node_modules/primeng/LICENSE.md](node_modules/primeng/LICENSE.md).

---

## This project qualifies for the free Community licence

Every criterion has to be met, and this project meets all of them comfortably:

| Criterion | Threshold | This project |
|---|---|---|
| Annual gross revenue | under $1,000,000 USD | none — personal tool |
| Developers | fewer than 5 | 1 |
| Employees | fewer than 10 | n/a |
| Outside capital ever received | under $3,000,000 USD | none |

Individuals, students, non-profits and non-commercial open source projects also qualify outright.

The Community licence is **not** a stripped-down build — it's the same core library as the Commercial
one, for up to 4 developer seats.

---

## Getting the key

1. Register at **<https://primeui.dev/licenses/community>**. It's self-service; you confirm your own
   eligibility.
2. A key is issued to you, valid for **12 months**.
3. Paste it into `primeUiLicenseKey` in **both** environment files:
   - [src/environments/environment.ts](src/environments/environment.ts)
   - [src/environments/environment.development.ts](src/environments/environment.development.ts)
4. Restart `ng serve`. The banner goes away.

It's already plumbed through — [app.config.ts](src/app/app.config.ts) passes it to `providePrimeNG`
as `license`. Nothing else to change.

**Set a reminder for the renewal.** The key expires after a year and renewal means re-confirming
eligibility. The banner reappearing is the only warning you get.

---

## Things not to do

- **Don't hide the banner with CSS.** It renders inside a *closed* shadow root with `all: initial` on
  a host that carries no meaningful id, specifically to defeat this. More to the point, the licence
  forbids removing its licence mechanisms — and the banner is the only signal that your key has
  expired.
- **Don't publish the key.** It's fine in a built bundle and contains nothing sensitive, but the
  terms prohibit publishing or distributing it so others can skip their own licence. If this repo
  ever goes public, move the key out of the committed environment files first — e.g. to a gitignored
  local file, or inject it at build time.
- **Don't try to forge one.** Verification is an offline Ed25519 signature check. There is no
  telemetry and no remote call, but there's also nothing to guess.

---

## If you'd rather not have a licensed dependency

PrimeNG's footprint here is deliberately small — `providePrimeNG`, the Aura theme preset, and
`primeng/table` in the table view. PrimeIcons is a separate, unaffected package. Dropping PrimeNG
would mean replacing the theme tokens and that one table; the three registries, the command surface
and the rest of the interface don't depend on it.

Not a recommendation, just the cost of the exit if the annual renewal turns out to be a nuisance.

## Sources

- [PrimeUI Community Licence](https://primeui.dev/licenses/community)
- [PrimeNG LICENSE.md](https://github.com/primefaces/primeng/blob/master/LICENSE.md)
- [Ng-News: PrimeNG's new licensing](https://dev.to/playfulprogramming-angular/ng-news-2617-primengs-new-licensing-and-a2ui-for-angular-4eik)
