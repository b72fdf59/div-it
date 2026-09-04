# Expense-sharing interface review

Reviewed 2026-09-05. This is a product-design snapshot, not a feature parity target.

## Competitor patterns

| Product | What it foregrounds | Useful lesson | Avoid copying |
| --- | --- | --- | --- |
| [Splitwise](https://www.splitwise.com/) | Balances, groups, a prominent add-expense action, and compact “paid by / split equally” language | Make routine expense entry fast and summarize its consequences in one sentence | Feature density, premium upsells, and account-first framing |
| [Tricount](https://www.tricount.com/) | A simple group expense list, balance overview, invitations, and offline entry | Keep the group—not financial analytics—as the primary context | Letting advanced splitting and multi-currency controls crowd the common path |
| [Settle Up](https://settleup.io/) | Member balances, who should pay next, transactions, and debt settlement in one group view | Put actionable settlement guidance near balances and recent activity | Large multicolor balance bubbles that compete with the ledger |
| [Splid](https://apps.apple.com/us/app/splid-split-group-bills/id991473495) | No-sign-up offline groups, optional sync, clean expense entry, and minimal-payment settlement | Treat accountless/offline behavior as normal rather than a technical mode | Hiding sync state so thoroughly that users cannot judge whether data is current |

## Shared conventions worth keeping

- A persistent, unmistakable add-expense action.
- Group context at the top of every daily-use screen.
- Equal split as the default, with advanced split controls progressively disclosed.
- Plain-language balance and settlement sentences.
- Chronological activity with payer and amount visible without opening each row.
- Group sharing through a link or QR code.

## Div It's opportunity

Div It should feel calmer than the category without becoming vague:

- Use one restrained emerald accent associated with safety, money, and successful synchronization; reserve coral for debt and amber for review states.
- Support a dark-first calm theme plus an equivalent light theme, without turning black backgrounds or neon green into a cryptocurrency aesthetic.
- Lead with the current member's position, then the next useful action.
- Keep setup, import, keys, and backup under Group rather than on the home screen.
- Show sync health in human language: “Up to date,” “Saved on this device,” or “Needs attention.”
- Treat conflicts as a small review inbox. Never resolve money through color, ordering, or hidden merge behavior.
- Pair a concise effective activity feed with a separate audit view.
- Avoid charts, category analytics, advertising surfaces, and AI entry in the first release.

## Proposed information architecture

1. **Activity** — personal balance summary, unresolved-review banner, recent effective events.
2. **Balances** — each member's position, minimal settlement plan, record-settlement action.
3. **Group** — participants, invites, device/sync status, import/export, recovery, and settings.
4. **Add expense** — persistent primary action opening a focused sheet or full-screen mobile form.

Desktop should expand these same concepts into a centered two-column layout, not become a different dashboard product.
