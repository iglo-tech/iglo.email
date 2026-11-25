// The instance Projects and Logs pages and the JSON for them (14-projects sections 9, 10 and 13;
// B143a, D157). Native: listmonk has no instance. The pages arrive with their rows; the Projects
// page's forms call /api/instance/projects through instance-projects.js with the instance CSRF.
import type { ProjectActivity } from "@/analytics/activity";
import type { LabelledLine } from "@/maintenance/log-buffer";
import type { DeletedProject } from "@/projects/deleted";
import type { NewProject, ProjectChange, ProjectRecord } from "@/projects/registry";

export const PROJECTS_PATH = "/admin/instance/projects";
export const LOGS_PATH = "/admin/instance/logs";

/**
 * One project, its root URL and its activity counts. A delete that stopped part way (B149a, D164)
 * has no counts and names the step that failed; it is not served until a new delete finishes it.
 */
export interface ProjectSummary extends ProjectRecord {
  readonly rootUrl: string;
  readonly activity: ProjectActivity | null;
  readonly deleteError: string | null;
}

/** The instance's lifecycle and read functions the pages and JSON routes use. */
export interface InstanceProjects {
  list(): ReadonlyArray<ProjectSummary>;
  /** Directories under `projects/` with no registry row: reported, never served. */
  leftovers(): ReadonlyArray<string>;
  create(input: NewProject): Promise<ProjectRecord>;
  update(slug: string, change: ProjectChange): Promise<ProjectRecord>;
  /** Null for a slug no project has. */
  remove(slug: string): Promise<DeletedProject | null>;
  /** The instance lines and every project's, labelled, newest last. */
  logs(): ReadonlyArray<LabelledLine>;
}

/** A project as the create and edit routes answer it. */
export function projectJson(project: ProjectRecord) {
  return {
    slug: project.slug,
    name: project.name,
    primary: project.primary,
    hostname: project.hostname,
    extra: [...project.extra],
    created_at: project.createdAt,
  };
}

/**
 * A project as the list answers it: the record, its root URL and its counts; a stopped delete has
 * null counts and `delete_error`.
 */
export function summaryJson(project: ProjectSummary) {
  return {
    ...projectJson(project),
    root_url: project.rootUrl,
    queued_marketing: project.activity?.queuedMarketing ?? null,
    running_campaigns: project.activity?.runningCampaigns ?? null,
    sent_24h: project.activity?.sent ?? null,
    delete_error: project.deleteError,
  };
}

function Field(props: {
  label: string;
  name: string;
  model: string;
  hint?: string;
  required?: boolean;
  pattern?: string;
  maxlength?: string;
  testid: string;
  readonly?: boolean;
}) {
  return (
    <label data-field="">
      {props.label}
      <input
        name={props.name}
        x-model={props.model}
        data-testid={props.testid}
        autocomplete="off"
        {...(props.required ? { required: true } : {})}
        {...(props.pattern ? { pattern: props.pattern } : {})}
        {...(props.maxlength ? { maxlength: props.maxlength } : {})}
        {...(props.readonly ? { readonly: true } : {})}
      />
      {props.hint ? <small data-hint="">{props.hint}</small> : null}
    </label>
  );
}

const EXTRA_HINT = "One hostname per line: lowercase, no port. They serve the project's old links.";

/** The Projects page's body: the list, the create form and the edit and delete dialogs. */
export function ProjectsBody(props: {
  projects: ReadonlyArray<ProjectSummary>;
  leftovers: ReadonlyArray<string>;
  instanceHost: string;
}) {
  const hasPrimary = props.projects.some((project) => project.primary);
  return (
    <section class="instance-projects" x-data="instanceProjects">
      <header class="hstack justify-between page-header">
        <h1 class="page-title">Projects</h1>
        <button type="button" data-variant="primary" data-testid="project-new" x-on:click="openNew">
          New project
        </button>
      </header>
      {props.leftovers.length ? (
        <div role="alert" data-variant="warning" class="mb-4" data-testid="project-leftovers">
          Not served: projects/{props.leftovers.join(", projects/")} has no registry row. Move it
          away or restore its project.
        </div>
      ) : null}
      <div class="card page-content">
        {props.projects.length ? (
          <table data-testid="projects-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Hostnames</th>
                <th class="align-right">Queued marketing</th>
                <th class="align-right">Running campaigns</th>
                <th class="align-right">Sent (24 h)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {props.projects.map((project) => (
                <tr data-testid="project-row" data-slug={project.slug}>
                  <td>
                    {project.deleteError === null ? (
                      <a
                        href={`/admin/instance/open/${encodeURIComponent(project.slug)}?next=%2Fadmin`}
                        data-testid="project-open"
                      >
                        {project.name}
                      </a>
                    ) : (
                      project.name
                    )}{" "}
                    {project.primary ? (
                      <span class="badge" data-testid="project-primary">
                        Primary
                      </span>
                    ) : null}
                    <br />
                    <small class="text-light">{project.slug}</small>
                    {project.deleteError === null ? null : (
                      <p role="alert" data-variant="danger" data-testid="project-delete-failed">
                        Not served: its delete stopped at {project.deleteError}. Delete it again to
                        finish.
                      </p>
                    )}
                  </td>
                  <td>
                    <code>{project.hostname}</code>
                    {project.extra.map((host) => (
                      <>
                        <br />
                        <small>
                          <code>{host}</code>
                        </small>
                      </>
                    ))}
                  </td>
                  <td class="align-right" data-testid="project-queued">
                    {project.activity ? String(project.activity.queuedMarketing) : "–"}
                  </td>
                  <td class="align-right" data-testid="project-running">
                    {project.activity ? String(project.activity.runningCampaigns) : "–"}
                  </td>
                  <td class="align-right" data-testid="project-sent">
                    {project.activity ? String(project.activity.sent) : "–"}
                  </td>
                  <td class="align-right">
                    <div class="hstack gap-1 justify-end">
                      {project.deleteError === null ? (
                        <button
                          type="button"
                          class="small outline"
                          data-testid="project-edit"
                          data-slug={project.slug}
                          x-on:click="openEdit"
                        >
                          Edit
                        </button>
                      ) : null}
                      <button
                        type="button"
                        class="small"
                        data-variant="danger"
                        data-testid="project-delete"
                        data-slug={project.slug}
                        x-on:click="openDelete"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="text-light" data-testid="projects-empty">
            There is no project. Create one; with the hostname {props.instanceHost} it can be the
            primary project.
          </p>
        )}
      </div>

      <dialog x-ref="newDialog" data-testid="project-new-dialog">
        <form class="dialog-card content" {...{ "x-on:submit.prevent": "create" }}>
          <header class="dialog-head">
            <h4 class="dialog-title">New project</h4>
          </header>
          <section class="dialog-body">
            <Field
              label="Slug"
              name="slug"
              model="form.slug"
              testid="project-slug"
              required
              pattern="[a-z0-9][a-z0-9\-]{0,39}"
              maxlength="40"
              hint="Lowercase letters, digits and hyphens. It never changes."
            />
            <Field
              label="Name"
              name="name"
              model="form.name"
              testid="project-name-input"
              required
              maxlength="200"
            />
            <Field
              label="Hostname"
              name="hostname"
              model="form.hostname"
              testid="project-hostname"
              required
              hint="Every new link and Message-ID uses it. It never changes."
            />
            <label data-field="">
              Extra hostnames
              <textarea name="extra" rows="2" x-model="form.extra" data-testid="project-extra" />
              <small data-hint="">{EXTRA_HINT}</small>
            </label>
            {hasPrimary ? null : (
              <label>
                <input
                  type="checkbox"
                  name="primary"
                  x-model="form.primary"
                  data-testid="project-primary-input"
                />{" "}
                Primary project (its hostname is the instance host, {props.instanceHost})
              </label>
            )}
          </section>
          <footer class="dialog-foot hstack justify-end gap-1">
            <button type="button" class="outline" x-on:click="closeDialogs">
              Cancel
            </button>
            <button type="submit" data-variant="primary" data-testid="project-create">
              Create
            </button>
          </footer>
        </form>
      </dialog>

      <dialog x-ref="editDialog" data-testid="project-edit-dialog">
        <form class="dialog-card content" {...{ "x-on:submit.prevent": "save" }}>
          <header class="dialog-head">
            <h4 class="dialog-title">
              Edit <code x-text="edit.slug"></code>
            </h4>
          </header>
          <section class="dialog-body">
            <Field
              label="Name"
              name="name"
              model="edit.name"
              testid="project-edit-name"
              required
              maxlength="200"
            />
            <label data-field="">
              Extra hostnames
              <textarea
                name="extra"
                rows="3"
                x-model="edit.extra"
                data-testid="project-edit-extra"
              />
              <small data-hint="">{EXTRA_HINT}</small>
            </label>
            <div
              role="alert"
              data-variant="warning"
              data-testid="project-extra-warning"
              x-show="removedHosts"
              style="display: none"
            >
              <p>
                Links in mail already sent from <span x-text="removedHosts"></span> stop working
                once it is removed.
              </p>
            </div>
          </section>
          <footer class="dialog-foot hstack justify-end gap-1">
            <button type="button" class="outline" x-on:click="closeDialogs">
              Cancel
            </button>
            <button type="submit" data-variant="primary" data-testid="project-save">
              Save
            </button>
          </footer>
        </form>
      </dialog>

      <dialog x-ref="deleteDialog" data-testid="project-delete-dialog">
        <form class="dialog-card content" {...{ "x-on:submit.prevent": "remove" }}>
          <header class="dialog-head">
            <h4 class="dialog-title">
              Delete <code x-text="doomed"></code>
            </h4>
          </header>
          <section class="dialog-body">
            <p>
              The project stops at once: its hostnames, links and unsubscribe pages stop working. A
              final snapshot of its database and uploads goes to backups/deleted/, then its
              directory is removed.
            </p>
            <label data-field="">
              Type the slug to confirm
              <input
                name="confirm"
                autocomplete="off"
                required
                x-model="confirm"
                data-testid="project-delete-confirm"
              />
            </label>
          </section>
          <footer class="dialog-foot hstack justify-end gap-1">
            <button type="button" class="outline" x-on:click="closeDialogs">
              Cancel
            </button>
            <button
              type="submit"
              data-variant="danger"
              data-testid="project-delete-submit"
              x-bind:disabled="confirmMismatch"
            >
              Delete
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  );
}

/** The instance Logs page's body: every line with its source, newest last. */
export function LogsBody(props: { lines: ReadonlyArray<LabelledLine> }) {
  return (
    <section class="logs relative">
      <header class="page-header">
        <h1 class="page-title">Logs</h1>
      </header>
      <div class="card page-content">
        <p class="text-light" data-testid="logs-help">
          Lines of the instance and of every project, labelled by slug. Reload for newer lines.
        </p>
        {props.lines.length ? (
          <div class="log-view">
            <div class="lines" data-testid="instance-log-lines">
              {props.lines.map(({ source, line }) => (
                <span class="line" data-source={source}>
                  <span class="timestamp">{line.slice(0, 26)}</span>{" "}
                  <span class="badge" data-testid="log-source">
                    {source}
                  </span>{" "}
                  <span class="log-message">{line.slice(26).replace(/^ \*: /, "")}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p data-testid="no-logs">No lines yet.</p>
        )}
      </div>
    </section>
  );
}
