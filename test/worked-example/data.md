# Worked example test data

Generated per run; no real addresses or credentials. Subscribers are
`<name>-<run id>@worked.example.test`, all created on the single opt-in list "Product news"
(status `unconfirmed`, which grants marketing permission on a single opt-in list).
Credentials: admin `worked-admin` / `worked-example-admin-password` (fixture only), plus an
API user created through the login at start.

## Sequences (all `active`)

| Sequence             | Trigger                                       | Steps                                                                                                                  | Other                                                     |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Prepaid onboarding   | `order_paid` where `data.product = "prepaid"` | Credits ready (`PT0S`, tx); Need a hand? (`PT10S`, marketing, `not download_finished since trigger`, `on_false: exit`) | `exit_on: [subscription_created]`, `reentry: never`, list |
| Second pack          | `order_paid` where `data.order_number = 2`    | Second pack: try the subscription (`PT0S`, marketing)                                                                  | `reentry: never`, list                                    |
| Subscription welcome | `subscription_created`                        | Welcome (`PT0S`, tx); Did the setup work? (`PT10S`, marketing, `not connected since trigger`)                          | `reentry: after_exit`, list                               |
| Monthly summary      | `subscription_monthly_summary`                | Your month (`PT0S`, marketing, `download_finished since P30D`)                                                         | `reentry: always`, list                                   |
| Payment failed       | `subscription_past_due`                       | Payment failed (`PT0S`, tx); Payment failed: second notice (`PT10S`, tx)                                               | `exit_on: [payment_succeeded]`, no list                   |
| Cancellation         | `subscription_canceled`                       | One question (`PT0S`, tx); Win-back (`PT10S`, marketing, `not feedback_given where data.reason = "price"`)             | `exit_on: [subscription_created]`, list                   |

## Subscribers and expected mail

| Who | Events                                                                                                                     | Receives                                                  | Never receives      |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------- |
| p1  | `order_paid` prepaid #1                                                                                                    | Credits ready, Need a hand?                               |                     |
| p2  | `order_paid` prepaid #1, `download_finished`                                                                               | Credits ready (enrollment exits: condition)               | Need a hand?        |
| p3  | prepaid #1, `download_finished`, prepaid #2, #3, #2 again                                                                  | Credits ready, Second pack once                           | Need a hand?        |
| s1  | `subscription_created`                                                                                                     | Welcome, Did the setup work?                              |                     |
| s2  | `subscription_created`, `connected`                                                                                        | Welcome (exits: condition)                                | Did the setup work? |
| m1  | `download_finished` 10 days ago, monthly summary `downloads: 42`                                                           | Your month (body shows 42)                                |                     |
| m2  | `download_finished` 40 days ago, monthly summary                                                                           | nothing (exits: condition)                                | Your month          |
| f1  | `subscription_past_due`, `payment_succeeded`                                                                               | Payment failed                                            | second notice       |
| f2  | `subscription_past_due`                                                                                                    | Payment failed, second notice                             |                     |
| c1  | `subscription_canceled`, `feedback_given` reason `price`                                                                   | One question                                              | Win-back            |
| c2  | `subscription_canceled`                                                                                                    | One question, Win-back                                    |                     |
| c3  | `subscription_canceled`, `subscription_created`                                                                            | One question, Welcome, Did the setup work?                | Win-back            |
| c4  | `subscription_canceled`, `feedback_given` reason `too_complex`                                                             | One question, Win-back                                    |                     |
| k1  | `order_paid` gift #2, `download_finished`, monthly summary                                                                 | Second pack, then Your month deferred by the cap          |                     |
| u1  | `order_paid` gift #2, `subscription_canceled`, `subscription_past_due`; unsubscribes by the email's link (page, then form) | Second pack, One question, Payment failed, second notice  | Win-back            |
| u2  | same; unsubscribes by RFC 8058 one-click from `List-Unsubscribe`                                                           | same as u1                                                | Win-back            |
| r1  | `subscription_past_due`; the process stops when step 2 is due                                                              | Payment failed, second notice (once, after restart)       |                     |
| e1  | `subscription_past_due` before the edit                                                                                    | Payment failed, final notice (new template, old due time) | second notice       |
| e4  | `subscription_past_due` after the edit                                                                                     | Payment failed, final notice after the new 40 s           | second notice       |
| d1  | `subscription_created` before Did the setup work? is deleted                                                               | Welcome, Tips                                             | Did the setup work? |
| d2  | `subscription_created` after the delete                                                                                    | Welcome, Tips                                             | Did the setup work? |
