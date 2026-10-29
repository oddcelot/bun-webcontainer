import { Show, useContext } from "solid-js";
import { Select } from "@kobalte/core/select";
import { examples, repoExamples } from "../examples";
import { AppContext } from "./context";

type Project = { label: string; value: string };

// Kobalte doesn't count an empty value as selected, so the demo (the empty `?example=`) goes by this inside the picker.
const DEMO = "#demo";
const toPicker = (value: string) => value || DEMO;
const fromPicker = (value: string) => (value === DEMO ? "" : value);
type Group = { label: string; options: Project[] };

/** The example projects, the GitHub ones, and this page's own project when it's neither (a repo or a share link). */
export function ProjectPicker() {
  const app = useContext(AppContext);
  const s = app.session;
  const groups = (extra: [string, string][]): Group[] => [
    { label: "Examples", options: [{ label: "Confetti demo", value: DEMO }, ...Object.entries(examples).map(([value, label]) => ({ label, value }))] },
    {
      label: "From GitHub",
      // The section says where they come from.
      options: Object.entries(repoExamples).map(([name, label]) => ({ label: label.replace(/ \(from GitHub\)$/, ""), value: `repo:${name}` })),
    },
    ...(extra.length ? [{ label: "This page", options: extra.map(([label, value]) => ({ label, value })) }] : []),
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
  return (
    <Select<Project, Group>
      options={props.groups}
      optionValue="value"
      optionTextValue="label"
      optionGroupChildren="options"
      value={props.current(props.groups)}
      // A shared project lives in the link only: picking it again has nothing to load.
      onChange={(p) => p && p.value !== "#shared" && fromPicker(p.value) !== s.project().selected && app.openProject(fromPicker(p.value))}
      placement="bottom-start"
      gutter={6}
      itemComponent={(p) => (
        <Select.Item item={p.item} class="select-option">
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
  );
}
