// Adapted from listmonk models/common.go (PageProps) and static/admin/partials (avatar, breadcrumbs,
// empty-state, filter-badge, list-selector, manage-lists-form) at 6fcd95f. These pages hold no
// stored text: anything from the database goes in through x-text and x-bind in the browser, and
// what comes from the URL through the JSX escaper.
import { Icon } from "@/admin/layout/icon";
import type { Translation } from "@/i18n/i18n";
import type { Child } from "@/jsx/render";

/** PageProps.Encode: the query without the named keys or empty values. */
export function encode(params: URLSearchParams, ...exclude: string[]): string {
  const out = new URLSearchParams();
  for (const [key, value] of params)
    if (value !== "" && !exclude.includes(key)) out.append(key, value);
  return out.toString();
}
/** PageProps.FilterURL. */
export function filterURL(base: string, params: URLSearchParams, ...exclude: string[]): string {
  const query = encode(params, "page", ...exclude);
  return query ? `${base}?${query}` : base;
}
/** PageProps.SortLink. */
export function SortLink(props: {
  base: string;
  params: URLSearchParams;
  field: string;
  label: string;
}) {
  const { base, params, field, label } = props;
  const current = params.get("order_by"),
    order = params.get("order");
  const next = new URLSearchParams(encode(params, "page"));
  next.set("order_by", field);
  next.set("order", current === field && order === "asc" ? "desc" : "asc");
  const sorted = current === field && (order === "asc" || order === "desc");
  return (
    <a
      href={`${base}?${next}`}
      data-sort-field={field}
      {...(sorted ? { "data-sorted": order } : {})}
    >
      {label}
    </a>
  );
}
/** PageProps.FormFields. */
export function HiddenFields(props: { params: URLSearchParams; exclude: string[] }) {
  return [...props.params]
    .filter(([key, value]) => value !== "" && !props.exclude.includes(key))
    .map(([name, value]) => <input type="hidden" name={name} value={value} />);
}
export function Alert({ name }: { name: string }) {
  return (
    <div
      role="alert"
      data-variant="danger"
      data-testid={name}
      x-show={name}
      x-text={name}
      style="display: none"
    ></div>
  );
}
export function EmptyState({ text }: { text: string }) {
  return (
    <div class="empty-state">
      <Icon name="sun" />
      <p>{text}</p>
    </div>
  );
}
/** Shown once a read has found nothing. */
export function EmptyRow(props: { when: string; colspan: number; t: Translation }) {
  return (
    <tr x-show={props.when} style="display: none">
      <td colspan={props.colspan}>
        <EmptyState text={props.t.T("globals.messages.emptyState")} />
      </td>
    </tr>
  );
}
export function FilterBadge(props: { label: Child; class?: string; url: string; t: Translation }) {
  const plain = !props.class || props.class === "tag";
  return (
    <span class={plain ? "filter-tag filter-default" : "filter-tag"}>
      <span class={`badge ${props.class ?? ""}`.trim()}>{props.label}</span>
      <a
        href={props.url}
        title={props.t.T("globals.buttons.remove")}
        data-testid="btn-remove-filter"
      >
        <Icon name="x" />
      </a>
    </span>
  );
}
/** The filter badge of a status named in the URL. */
export function StatusBadge(props: { status: string; url: string; t: Translation }) {
  const { status, url, t } = props;
  return (
    <FilterBadge
      t={t}
      url={url}
      class={/^[a-z]+$/.test(status) ? `status-${status}` : ""}
      label={
        <>
          <span class="dot">●</span> {t.T(`globals.terms.${status}`)}
        </>
      }
    />
  );
}

/** partials/avatar.html: `name` and `href` are Alpine expressions. */
export function AvatarLink(props: { kind: string; name: string; href: string; title: string }) {
  return (
    <a
      class={`unstyled avatar-icon avatar-${props.kind}`}
      x-bind:href={props.href}
      x-bind:title={props.title}
      x-bind:aria-label={props.title}
    >
      <span class="avatar-initials" aria-hidden="true" x-text={`initials(${props.name})`}></span>
    </a>
  );
}
export function Breadcrumbs(props: {
  parent: string;
  href: string | null;
  current: Child;
  /** A level above `parent`. */
  root?: { label: string; href: string | null };
}) {
  const { root } = props;
  return (
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {root ? (
          <li>{root.href ? <a href={root.href}>{root.label}</a> : <span>{root.label}</span>}</li>
        ) : null}
        <li>
          {root ? <span aria-hidden="true">/</span> : null}
          {props.href ? <a href={props.href}>{props.parent}</a> : <span>{props.parent}</span>}
        </li>
        <li>
          <span aria-hidden="true">/</span>
          <a href="" aria-current="page">
            {props.current}
          </a>
        </li>
      </ol>
    </nav>
  );
}
export function ListSelector(props: {
  model: string;
  id: string;
  label?: string;
  placeholder?: string;
  disabled?: string;
  t: Translation;
}) {
  const { model, id, label, placeholder, disabled, t } = props;
  const complete = "listAutocomplete($el)";
  return (
    <label data-field="">
      {label ?? null}
      <ot-taginput x-model={model} {...(disabled ? { "x-bind:disabled": disabled } : {})}>
        <input
          list={id}
          placeholder={placeholder ?? t.T("subscribers.listsPlaceholder")}
          x-on:input={complete}
          x-on:pointerdown={complete}
          x-on:focus={complete}
        />
        <datalist id={id}></datalist>
      </ot-taginput>
      <small data-hint="">{t.T("subscribers.listsHelp")}</small>
    </label>
  );
}
export function Preconfirm(props: { model: string; enabled: string; t: Translation }) {
  const { model, enabled, t } = props;
  return (
    <label data-field="" x-bind:aria-disabled={`!${enabled}`}>
      <input
        type="checkbox"
        x-model={model}
        data-testid="preconfirm"
        x-bind:disabled={`!${enabled}`}
      />{" "}
      {t.T("subscribers.preconfirm")}
      <small data-hint="">{t.T("subscribers.preconfirmHelp")}</small>
    </label>
  );
}
/**
 * partials/campaign-preview.html and template-preview.html. The frame is sandboxed with nothing
 * allowed, unlike upstream's: an email needs no script, so its HTML cannot run on this origin.
 */
export function PreviewDialog({ t }: { t: Translation }) {
  return (
    <dialog class="preview-modal" x-ref="previewDialog" x-on:close="onPreviewClose">
      <div class="dialog-card">
        <header class="dialog-head hstack justify-between">
          <h4 class="dialog-title" x-text="preview.title"></h4>
        </header>
        <section class="dialog-body preview" x-bind:aria-busy="preview.loading">
          <iframe
            sandbox=""
            x-ref="previewFrame"
            title={t.T("globals.buttons.preview")}
          ></iframe>
        </section>
        <footer class="dialog-foot align-right">
          <button type="button" class="outline" autofocus x-on:click="$refs.previewDialog.close()">
            {t.T("globals.buttons.close")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
/** partials/manage-lists-form.html. */
export function ManageLists(props: { model: string; id: string; t: Translation }) {
  const { model, id, t } = props;
  const action = (value: string, label: string) => (
    <label>
      <input
        type="radio"
        name={`${id}-action`}
        value={value}
        x-model={`${model}.action`}
        data-testid={`check-list-${value}`}
      />{" "}
      {label}
    </label>
  );
  return (
    <>
      <fieldset class="hstack">
        <legend>{t.T("globals.fields.action")}</legend>
        {action("add", t.T("globals.buttons.add"))}
        {action("remove", t.T("globals.buttons.remove"))}
        {action("unsubscribe", t.T("subscribers.markUnsubscribed"))}
      </fieldset>
      <ListSelector model={`${model}.lists`} id={id} label={t.T("globals.terms.lists")} t={t} />
      <Preconfirm model={`${model}.preconfirm`} enabled={`${model}HasOptinList`} t={t} />
    </>
  );
}
