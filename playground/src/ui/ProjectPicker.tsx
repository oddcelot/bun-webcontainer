import { Show, useContext } from "solid-js";
import { Select } from "@kobalte/core/select";
import { examples, repoExamples } from "../examples";
import { AppContext } from "./context";

type Project = { label: string; value: string; icon?: string };

// Kobalte doesn't count an empty value as selected, so the demo (the empty `?example=`) goes by this inside the picker.
const DEMO = "#demo";
const toPicker = (value: string) => value || DEMO;
const fromPicker = (value: string) => (value === DEMO ? "" : value);

// Entries that ask for a project instead of naming one.
const OPEN_FOLDER = "#open-folder";
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

  function openRepo() {
    const input = prompt("GitHub repo (owner/repo, owner/repo@ref or a github.com URL)", app.repoParam || "oddcelot/bun-elysia-demo");
    if (input) app.openProject(`repo:${input.trim()}`);
  }

  function pick(p: Project | null) {
    // The select stays on the current project (value is controlled) unless the page navigates away.
    if (!p) return;
    if (p.value === OPEN_FOLDER) return folderInput.click();
    if (p.value === OPEN_REPO) return openRepo();
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
    </>
  );
}
