# Language data provenance

The 38 JSON files in this directory are copied byte for byte from
[listmonk](https://github.com/knadh/listmonk/tree/6fcd95f32bb633d3a62a06c383c0b3322eecc898/i18n)
`v7.0.0-beta.1`, commit `6fcd95f32bb633d3a62a06c383c0b3322eecc898`.
They retain their original keys and values and are covered by the project's
inherited AGPL-3.0 license. The formatter excludes these copied files.

iglo.email adds keys of its own (for example the send log, the skip reasons and
the subscriber statistics, B127). Each of these is in `en.json`, and in every
other file with the English text until a translator updates it. A key a file
lacks falls back to English, so the other packs stay correct without it. The sequence keys (`sequences.*`) are in
`en.json` only.

English is the verified default. Other packs are included as upstream data;
their translations have not been reviewed by iglo.email. All packs are embedded
in the compiled executable. A selected pack overlays English; missing keys and
unknown language codes fall back to English.
