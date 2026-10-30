import { Show, createSignal, useContext } from "solid-js";
import { Select } from "@kobalte/core/select";
import { examples, repoExamples } from "../examples";
import { AppContext } from "./context";
import { PromptDialog } from "./PromptDialog";

type Project = { label: string; value: string; icon?: string };

// Kobalte doesn't count an empty value as selected, so the demo (the empty `?example=`) goes by this inside the picker.
const DEMO = "#demo";
const toPicker = (value: string) => value || DEMO;
const fromPicker = (value: string) => (value === DEMO ? "" : value);

// Entries that ask for a project instead of naming one.
const OPEN_FOLDER = "#open-folder";
const OPEN_ZIP = "#open-zip";
const OPEN_REPO = "#open-repo";
type Group = { label: string; options: Project[] };

/**
 * The project switcher: the example projects, the GitHub ones, this page's own project when it's neither (a repo or
 * a share link), and entries to open a local folder or any GitHub repo.
 */
export function ProjectPicker() {
  const app = useContext(AppContext);
  const s = app.session;
  const groups = (extra: [string, string][]): Group[] => [
    {
      label: "Examples",
      options: [{ label: "Confetti demo", value: DEMO }, ...Object.entries(examples).map(([value, label]) => ({ label, value }))],
    },
    {
      label: "From GitHub",
      // The section says where they come from.
      options: Object.entries(repoExamples).map(([name, label]) => ({
        label: label.replace(/ \(from GitHub\)$/, ""),
        value: `repo:${name}`,
      })),
    },
    ...(extra.length ? [{ label: "This page", options: extra.map(([label, value]) => ({ label, value })) }] : []),
    {
      label: "Open",
      options: [
        { label: "Folder…", value: OPEN_FOLDER, icon: "i-lucide-folder-open" },
        { label: "Zip file…", value: OPEN_ZIP, icon: "i-lucide-file-archive" },
        { label: "GitHub repo…", value: OPEN_REPO, icon: "i-lucide-github" },
      ],
    },
  ];
  const current = (list: Group[]) => list.flatMap((g) => g.options).find((o) => o.value === toPicker(s.project().selected)) ?? null;
  // Rebuilt when "This page" changes (once, at startup): changing a mounted Select's options logs STRICT_READ_UNTRACKED
  // from inside Kobalte.
  return (
    <Show when={JSON.stringify(s.project().extra)} keyed>
      {(key) => <Picker groups={groups(JSON.parse(key))} current={current} />}
    </Show>
  );
}

function Picker(props: { groups: Group[]; current: (list: Group[]) => Project | null }) {
  const app = useContext(AppContext);
  const s = app.session;
  let folderInput!: HTMLInputElement;
  let zipInput!: HTMLInputElement;

  const [asking, setAsking] = createSignal(false);

  function pick(p: Project | null) {
    // The select stays on the current project (value is controlled) unless the page navigates away.
    if (!p) return;
    if (p.value === OPEN_FOLDER) return folderInput.click();
    if (p.value === OPEN_ZIP) return zipInput.click();
    // Once the Select has closed and handed focus back to its trigger, or that would win over the dialog.
    if (p.value === OPEN_REPO) return void setTimeout(() => setAsking(true));
    // A shared project lives in the link only: picking it again has nothing to load.
    if (p.value !== "#shared" && fromPicker(p.value) !== s.project().selected) app.openProject(fromPicker(p.value));
  }

  return (
    <>
      <Select<Project, Group>
        options={props.groups}
        optionValue="value"
        optionTextValue="label"
        optionGroupChildren="options"
        value={props.current(props.groups)}
        onChange={pick}
        placement="bottom-start"
        gutter={6}
        itemComponent={(p) => (
          <Select.Item item={p.item} class="select-option">
            <Show when={p.item.rawValue.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
            <Select.ItemLabel class="name">{p.item.rawValue.label}</Select.ItemLabel>
            <Select.ItemIndicator class="check">
              <i class="i-lucide-check" aria-hidden="true" />
            </Select.ItemIndicator>
          </Select.Item>
        )}
        sectionComponent={(p) => <Select.Section class="select-section">{p.section.rawValue.label}</Select.Section>}
      >
        <Select.Trigger id="example" class="select-trigger" title="Example project" aria-label="Example project">
          <Select.Value<Project> class="value">{(state) => <span class="name">{state.selectedOption().label}</span>}</Select.Value>
          <Select.Icon class="chevron">
            <i class="i-lucide-chevron-down" aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content class="select-menu">
            <Select.Listbox class="select-list" />
          </Select.Content>
        </Select.Portal>
      </Select>
      <PromptDialog
        open={asking()}
        onOpenChange={setAsking}
        title="Open a GitHub repo"
        description="owner/repo, owner/repo@ref or a github.com URL"
        label="Repository"
        initial={app.repoParam || "oddcelot/bun-elysia-demo"}
        submit="Open"
        onSubmit={(input) => app.openProject(`repo:${input}`)}
        returnFocus={() => document.getElementById("example")}
      />
      <input
        ref={folderInput}
        id="folderinput"
        type="file"
        webkitdirectory
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) app.openFolder(files);
        }}
      />
      <input
        ref={zipInput}
        id="zipinput"
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) app.openZip(file);
        }}
      />
    </>
  );
}
