# The Octopus Energy API

Base URL: `https://api.octopus.energy/v1`

Everything OctoPrice uses is **public and unauthenticated**. An API key is
only needed for customer account data, which the MVP does not touch.

## Endpoints in use

### Products

```text
GET /products/?page_size=100
```

Paginated. Each result carries `code`, `direction` (`IMPORT` / `EXPORT`),
`available_from` and `available_to`.

The current Agile import product is the most recently available product whose
code starts with `AGILE-` and whose direction is `IMPORT`. The export tariff
(`AGILE-OUTGOING-…`) is excluded by the direction check.

At the time of writing the current product is **`AGILE-24-10-01`**. It is
discovered at startup rather than hard-coded, with a fallback constant if the
products endpoint cannot be reached.

### Unit rates

```text
GET /products/{product}/electricity-tariffs/{tariff}/standard-unit-rates/
      ?period_from=2026-08-26T23:00:00Z
      &period_to=2026-08-27T23:00:00Z
      &page_size=1500
```

Returns records like:

```json
{
  "value_exc_vat": 25.26,
  "value_inc_vat": 26.523,
  "valid_from": "2026-08-27T21:30:00Z",
  "valid_to": "2026-08-27T22:00:00Z",
  "payment_method": null
}
```

- Use **`value_inc_vat`** for anything a user sees or a rule compares. It is
  what people actually pay.
- Values are pence per kWh and can be **negative**.
- Results come back **newest first**.
- `period_from` is inclusive, `period_to` exclusive.
- Always send **UTC ISO-8601** timestamps. The Octopus documentation
  recommends this specifically to avoid daylight-saving errors, and it means
  a 23-hour or 25-hour local day asks for exactly the right window.

## Tariff codes

```text
E-1R-{PRODUCT_CODE}-{REGION}
```

`E-1R` is electricity, single register. Example:
`E-1R-AGILE-24-10-01-C` is Agile in London.

There are **14** distribution regions: A B C D E F G H J K L M N P. There is
no `I` or `O`, to avoid confusion with the digits 1 and 0.

## Behaviour worth knowing

### Publication is a window, not a moment

Next-day prices usually appear from about 16:00 UK time, but Octopus terms
allow until roughly 22:00. Do not assume 16:00, and do not assume one request
is enough.

### A day can arrive partially

Observed directly against the live API: at 17:46 on 26 August 2026, the
following day held **46 of its 48 periods**, with the last hour still to come.
Treating that as "published" would have produced a daily summary with a
missing evening, and a cheapest-window answer computed from incomplete data.

This is why `isDayComplete` requires the full expected count, contiguity, and
local-midnight-to-local-midnight coverage before a day counts.

### Duplicates and corrections

The same period can be returned more than once across overlapping requests,
and a price can be republished with a corrected value. Periods are keyed on
`valid_from`, with later values winning, both in memory and in the
`(tariff_code, valid_from)` unique constraint.

### Daylight saving

Verified against live data: six consecutive complete days each held exactly
48 periods within their local-day window. On transition days the local day is
46 or 50 periods, which the request window and the completeness check both
account for.

### `valid_to` can be null

Open-ended rates report `valid_to: null`. Agile always sets it, but the client
fills a missing value with `valid_from + 30 minutes` rather than dropping the
record.

## Error handling

| Condition            | Behaviour                                     |
| -------------------- | --------------------------------------------- |
| 5xx                  | Retry with exponential backoff                |
| 429                  | Retry with exponential backoff                |
| 4xx (e.g. 404)       | Fail immediately; a bad tariff code never fixes itself |
| Network error        | Retry                                         |
| Timeout (15s)        | Retry                                         |
| Unexpected JSON shape| Fail loudly rather than store nonsense        |

Failures are logged as `OCTOPUS_API_ERROR` and never silently swallowed.

## Rate limiting

OctoPrice makes a handful of requests a day: two at startup, then one every
five minutes during the publication window until the day is complete. This is
well within any reasonable use of a public endpoint. If you shorten
`POLL_INTERVAL_MINUTES`, keep that in mind.
