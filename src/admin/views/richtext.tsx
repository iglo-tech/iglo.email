// Adapted from listmonk static/admin/partials/richtext-editor.html at 6fcd95f.
import { Icon } from "@/admin/layout/icon";
import type { Translation } from "@/i18n/i18n";
import type { Child } from "@/jsx/render";

const file = "richtext-icons.svg";
const icon = (name: string) => <Icon name={name} file={file} />;

function Toolbar({ t }: { t: Translation }) {
  /** A toolbar button named by its title. */
  const command = (
    cmd: string,
    title: string,
    name: string,
    extra: Record<string, string> = {},
  ) => (
    <button type="button" class="ghost" data-cmd={cmd} title={title} aria-label={title} {...extra}>
      {icon(name)}
    </button>
  );
  const tool = (cmd: string, key: string, name: string, extra: Record<string, string> = {}) =>
    command(cmd, t.T(`editor.${key}`), name, extra);
  const block = (value: string, label: Child) => (
    <button type="button" role="menuitem" class="ghost" data-cmd="block" data-value={value}>
      {label}
    </button>
  );
  const heading = (level: number) => {
    const label = `${t.T("editor.heading")} ${level}`;
    const Tag = `h${level}` as "h1";
    return block(`H${level}`, <Tag>{label}</Tag>);
  };
  const colors = (name: string, key: string, glyph: string, value: string) => (
    <ot-dropdown>
      <button
        type="button"
        class="ghost"
        popovertarget={`rte-${name}`}
        title={t.T(key)}
        aria-label={t.T(key)}
      >
        {icon(glyph)}
      </button>
      <menu popover="" id={`rte-${name}`} class="rte-colors">
        <div class="rte-swatches" data-rte-palette={name}></div>
        <fieldset class="group rte-color-custom" data-rte-colorinput={name}>
          <input type="color" name="picker" value={value} title={t.T(key)} aria-label={t.T(key)} />
          <input
            type="text"
            name="hex"
            size="8"
            placeholder={value}
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
          <button type="button" class="outline small" data-rte-act="applycolor">
            {t.T("globals.buttons.apply")}
          </button>
        </fieldset>
      </menu>
    </ot-dropdown>
  );
  return (
    <div class="rte-toolbar" role="toolbar" aria-label={t.T("editor.toolbar")}>
      <div class="rte-group">
        {command("undo", t.T("globals.buttons.undo"), "rotate-ccw")}
        {command("redo", t.T("globals.buttons.redo"), "rotate-cw")}
      </div>

      <div class="rte-group">
        <ot-dropdown class="rte-blockformat">
          <button
            type="button"
            class="ghost rte-select"
            popovertarget="rte-blockformat"
            title={t.T("editor.blockFormat")}
          >
            <span data-rte-blocklabel="">{t.T("editor.paragraph")}</span> {icon("chevron-down")}
          </button>
          <menu popover="" id="rte-blockformat" class="rte-menu">
            {block("P", t.T("editor.paragraph"))}
            {[1, 2, 3, 4, 5, 6].map(heading)}
            {block("BLOCKQUOTE", t.T("editor.blockquote"))}
            {block("PRE", t.T("globals.terms.code"))}
          </menu>
        </ot-dropdown>
        <ot-dropdown>
          <button
            type="button"
            class="ghost rte-select"
            popovertarget="rte-fontsize"
            title={t.T("editor.fontSize")}
          >
            {icon("type")} {icon("chevron-down")}
          </button>
          <menu popover="" id="rte-fontsize" class="rte-menu">
            {[10, 11, 12, 14, 15, 16, 18, 24, 36].map((size) => (
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-cmd="fontsize"
                data-value={`${size}px`}
              >
                {size}
              </button>
            ))}
          </menu>
        </ot-dropdown>
      </div>

      <div class="rte-group">
        {tool("bold", "bold", "bold", { "data-format": "B" })}
        {tool("italic", "italic", "italic", { "data-format": "I" })}
        {tool("underline", "underline", "underline", { "data-format": "U" })}
        {tool("strikethrough", "strikethrough", "strikethrough", { "data-format": "S" })}
        {colors("forecolor", "editor.textColor", "text-color", "#000000")}
        {colors("backcolor", "editor.highlightColor", "highlight", "#ffff00")}
      </div>

      <div class="rte-group">
        {tool("align", "alignLeft", "align-left", { "data-value": "left" })}
        {tool("align", "alignCenter", "align-center", { "data-value": "center" })}
        {tool("align", "alignRight", "align-right", { "data-value": "right" })}
        {tool("align", "alignJustify", "align-justify", { "data-value": "justify" })}
      </div>

      <div class="rte-group">
        {tool("ul", "bulletList", "list", { "data-format": "UL" })}
        {tool("ol", "numberList", "list-ordered", { "data-format": "OL" })}
        {tool("outdent", "outdent", "outdent")}
        {tool("indent", "indent", "indent")}
      </div>

      <div class="rte-group">
        {command("image", t.T("globals.terms.image"), "image")}
        {command("link", t.T("globals.terms.link"), "link")}
        <ot-dropdown>
          <button
            type="button"
            class="ghost"
            popovertarget="rte-tablegrid"
            title={t.T("globals.terms.table")}
            aria-label={t.T("globals.terms.table")}
          >
            {icon("table")}
          </button>
          <div popover="" id="rte-tablegrid" class="rte-menu rte-tablegrid">
            <div class="rte-tablegrid-cells" data-rte-tablegrid=""></div>
            <div class="rte-tablegrid-label" data-rte-tablegrid-label=""></div>
          </div>
        </ot-dropdown>
        {tool("removeformat", "removeFormat", "remove-format")}
        {command("source", "HTML", "code")}
      </div>

      <div class="rte-group">
        {tool("anchor", "anchor", "anchor")}
        {tool("subscript", "subscript", "subscript", { "data-format": "SUB" })}
        {tool("superscript", "superscript", "superscript", { "data-format": "SUP" })}
        {tool("hr", "hr", "minus")}
        <ot-dropdown>
          <button
            type="button"
            class="ghost"
            popovertarget="rte-charmap"
            title={t.T("editor.specialChar")}
            aria-label={t.T("editor.specialChar")}
          >
            <span aria-hidden="true">Ω</span>
          </button>
          <div popover="" id="rte-charmap" class="rte-menu rte-glyphpop">
            <div class="rte-grid" data-rte-charmap=""></div>
          </div>
        </ot-dropdown>
        <ot-dropdown>
          <button
            type="button"
            class="ghost"
            popovertarget="rte-emoji"
            title={t.T("globals.terms.emoji")}
            aria-label={t.T("globals.terms.emoji")}
          >
            {icon("smile")}
          </button>
          <div popover="" id="rte-emoji" class="rte-menu rte-glyphpop">
            <div class="rte-grid" data-rte-emoji=""></div>
          </div>
        </ot-dropdown>
        {tool("insert-html", "insertHTML", "plus-square")}
      </div>

      <div class="rte-group">
        <ot-dropdown>
          <button
            type="button"
            class="ghost"
            popovertarget="rte-find"
            title={t.T("editor.findReplace")}
            aria-label={t.T("editor.findReplace")}
          >
            {icon("search")}
          </button>
          <div popover="" id="rte-find" class="rte-menu rte-find" data-rte-find="">
            <input type="text" name="find" placeholder={t.T("globals.buttons.find")} />
            <input type="text" name="replace" placeholder={t.T("globals.fields.replaceWith")} />
            <div class="hstack justify-between">
              <label class="rte-find-opt">
                <input type="checkbox" name="matchcase" /> {t.T("editor.matchCase")}
              </label>
              <small data-hint="">
                <span data-rte-findcount=""></span>
              </small>
            </div>
            <div class="hstack gap-1">
              <button type="button" class="outline small" data-rte-act="next">
                {t.T("editor.findNext")}
              </button>
              <button type="button" class="outline small" data-rte-act="replace">
                {t.T("globals.buttons.replace")}
              </button>
              <button type="button" class="small" data-rte-act="replaceAll">
                {t.T("globals.buttons.replaceAll")}
              </button>
            </div>
          </div>
        </ot-dropdown>
        {command("fullscreen", t.T("globals.buttons.fullscreen"), "maximize")}
        {command("help", t.T("globals.terms.help"), "help-circle")}
      </div>

      <ot-dropdown class="rte-overflow" hidden>
        <button
          type="button"
          class="ghost"
          popovertarget="rte-overflow-menu"
          title={t.T("globals.buttons.more")}
          aria-label={t.T("globals.buttons.more")}
        >
          {icon("more-vertical")}
        </button>
        <menu popover="" id="rte-overflow-menu" class="rte-overflow-menu"></menu>
      </ot-dropdown>
    </div>
  );
}
function Dialogs({ t }: { t: Translation }) {
  const close = (
    <button type="button" class="outline" data-rte-act="cancel">
      {t.T("globals.buttons.close")}
    </button>
  );
  const submit = (label: string) => (
    <button type="button" data-variant="primary" data-rte-act="submit">
      {label}
    </button>
  );
  const text = (label: string, name: string, autofocus = false) => (
    <div data-field="">
      <label>{label}</label>
      <input type="text" name={name} {...(autofocus ? { autofocus: true } : {})} />
    </div>
  );
  const size = (label: string, name: string) => (
    <div data-field="">
      <label>{label}</label>
      <input type="number" name={name} min="1" step="1" inputmode="numeric" />
    </div>
  );
  const code = (name: string, title: string, label: string) => (
    <dialog class="rte-dialog rte-dialog-code" data-rte-dialog={name}>
      <div class="dialog-card">
        <header class="dialog-head">
          <h4 class="dialog-title">{title}</h4>
        </header>
        <section class="dialog-body" data-rte-code=""></section>
        <footer class="dialog-foot align-right">
          <button type="button" class="outline" data-rte-act="format">
            {t.T("editor.formatHTML")}
          </button>
          {close}
          {submit(label)}
        </footer>
      </div>
    </dialog>
  );
  const shortcuts: [string, string][] = [
    ["Ctrl / ⌘ + B", t.T("editor.bold")],
    ["Ctrl / ⌘ + I", t.T("editor.italic")],
    ["Ctrl / ⌘ + U", t.T("editor.underline")],
    ["Ctrl / ⌘ + Z", t.T("globals.buttons.undo")],
    ["Ctrl / ⌘ + Shift + Z", t.T("globals.buttons.redo")],
    ["Ctrl / ⌘ + K", t.T("globals.terms.link")],
    ["Ctrl / ⌘ + S", t.T("globals.buttons.save")],
    ["F9", t.T("globals.buttons.preview")],
  ];
  return (
    <>
      <dialog class="rte-dialog" data-rte-dialog="link">
        <form method="dialog" class="dialog-card">
          <header class="dialog-head">
            <h4 class="dialog-title">{t.T("globals.terms.link")}</h4>
          </header>
          <section class="dialog-body">
            {text(t.T("globals.terms.url"), "url", true)}
            {text(t.T("globals.terms.text"), "text")}
            {text(t.T("globals.fields.title"), "title")}
            <label data-field="">
              <input type="checkbox" name="track" /> {t.T("editor.trackLink")}
            </label>
          </section>
          <footer class="dialog-foot align-right">
            <button type="button" class="outline" data-rte-act="unlink">
              {t.T("editor.removeLink")}
            </button>
            {close}
            {submit(t.T("globals.buttons.apply"))}
          </footer>
        </form>
      </dialog>

      <dialog class="rte-dialog" data-rte-dialog="image">
        <form method="dialog" class="dialog-card">
          <header class="dialog-head">
            <h4 class="dialog-title">{t.T("globals.terms.image")}</h4>
          </header>
          <section class="dialog-body">
            <div data-field="">
              <label>{t.T("editor.source")}</label>
              <div class="hstack gap-2">
                <input type="text" name="src" style="flex:1" autofocus />
                <button type="button" class="outline" data-rte-act="browse">
                  {icon("image")} {t.T("globals.terms.media")}
                </button>
              </div>
            </div>
            {text(t.T("editor.altText"), "alt")}
            <div class="hstack gap-2">
              <div class="rte-img-dims">
                {size(t.T("globals.fields.width"), "width")}
                <button
                  type="button"
                  class="ghost rte-img-lock is-active"
                  data-rte-act="lock"
                  aria-pressed="true"
                  title={t.T("editor.constrain")}
                  aria-label={t.T("editor.constrain")}
                >
                  {icon("lock")}
                </button>
                {size(t.T("globals.fields.height"), "height")}
              </div>
              <div data-field="">
                <label>{t.T("editor.float")}</label>
                <select name="float">
                  <option value="">{t.T("globals.terms.none")}</option>
                  <option value="img-float-left">{t.T("editor.floatLeft")}</option>
                  <option value="img-float-right">{t.T("editor.floatRight")}</option>
                </select>
              </div>
            </div>
            <label data-field="">
              <input type="checkbox" name="embed" /> {t.T("editor.embed")}
            </label>
          </section>
          <footer class="dialog-foot align-right">
            {close}
            {submit(t.T("globals.buttons.insert"))}
          </footer>
        </form>
      </dialog>

      {code("source", "HTML", t.T("globals.buttons.save"))}
      {code("insert-html", t.T("editor.insertHTML"), t.T("globals.buttons.insert"))}

      <dialog class="rte-dialog" data-rte-dialog="help">
        <div class="dialog-card">
          <header class="dialog-head">
            <h4 class="dialog-title">{t.T("globals.terms.keyboardShortcuts")}</h4>
          </header>
          <section class="dialog-body">
            <table class="rte-shortcuts">
              {shortcuts.map(([keys, label]) => (
                <tr>
                  <td>{keys}</td>
                  <td>{label}</td>
                </tr>
              ))}
            </table>
          </section>
          <footer class="dialog-foot align-right">{close}</footer>
        </div>
      </dialog>
    </>
  );
}

/** The body arrives from the API, through `init`, an Alpine expression. */
export function RichtextEditor({ t, init }: { t: Translation; init: string }) {
  return (
    <richtext-editor x-init={init} x-on:input="form.body = $event.target.value">
      <Toolbar t={t} />
      <div class="rte-content" data-rte-content=""></div>
      <div class="rte-statusbar">
        <span data-rte-path="" class="rte-path"></span>
        <span data-rte-wordcount="" class="rte-wordcount"></span>
      </div>
      <Dialogs t={t} />
    </richtext-editor>
  );
}
