# Language data provenance

The 38 JSON files in this directory are copied byte for byte from
[listmonk](https://github.com/knadh/listmonk/tree/6fcd95f32bb633d3a62a06c383c0b3322eecc898/i18n)
`v7.0.0-beta.1`, commit `6fcd95f32bb633d3a62a06c383c0b3322eecc898`.
They retain their original keys and values and are covered by the project's
inherited AGPL-3.0 license. The formatter excludes these copied files.

iglo.email adds keys of its own (for example the send log, the skip reasons and
the subscriber statistics, B127). Each of these is in `en.json`. Most are not
copied into the other files (`de.json`, for instance, lacks many of them), so a
pack shows English for them until a translator adds the key. A key a file lacks falls back to English, so the other
packs stay correct without it. The sequence keys (`sequences.*`) are in
`en.json` only.

English is the verified default. Other packs are included as upstream data;
their translations have not been reviewed by iglo.email. All packs are embedded
in the compiled executable. A selected pack overlays English; missing keys and
unknown language codes fall back to English.
