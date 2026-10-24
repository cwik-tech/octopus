# Third-party source and asset notices

The root `LICENSE` applies to original Octopus code. Third-party material keeps
its own terms; this document does not relicense it or establish ownership of
unattributed material. Source-publication requirements are in the
[publication checklist](Public-Source-Release.md#publication-checklist).

## Included source and assets

| Material | Location | Upstream and retained notice |
| --- | --- | --- |
| shadcn/ui primitives and Tailwind helpers | `ui/src/components/ui/`, `ui/src/styles/vendor/shadcn.css` | [shadcn/ui](https://github.com/shadcn-ui/ui), MIT, copyright 2023 shadcn. [Full notice](licenses/shadcn-ui.txt). Local primitives include Octopus adaptations. |
| AI Elements components | `ui/src/components/ai-elements/` | [Vercel AI Elements](https://github.com/vercel/ai-elements), Apache-2.0, copyright 2023 Vercel, Inc. [Upstream notice](licenses/ai-elements.txt); full Apache license in the root `LICENSE`. Components are locally adapted. |
| SVG icon sprite | `ui/public/icons.svg` | Exact match to the [Vite React TypeScript template](https://github.com/vitejs/vite/blob/main/packages/create-vite/template-react-ts/public/icons.svg). MIT, copyright VoidZero Inc. and Vite contributors. [Full notice](licenses/vite-template.txt). |
| Unslop skill material | `agents/architect-agent-systems/skills/unslop/`, `agents/architect-critic/skills/unslop/`, `agents/architect-security-privacy/skills/unslop/` | Contains adapted patterns matching [Cursor pstack Unslop](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop). MIT, copyright 2026 Lauren Tan. [Full notice](licenses/cursor-pstack.txt). The local instructions differ from current upstream. |
| Pi provider mark | `ui/src/assets/pi.svg` | Monochrome adaptation of the official [Pi SVG](https://pi.dev/logo-auto.svg). The [official press kit](https://pi.dev/press-kit) distributes the logo and labels the site MIT License, with attribution to Earendil Inc. & Contributors. Retain that attribution and the [upstream MIT notice](licenses/pi-1.3.0.txt), copyright 2025 Mario Zechner. No trademark ownership or endorsement is claimed. |

The Unslop paths above are an attribution to identified shared material, not a
claim that every other agent or skill was independently authored. Their remaining
provenance must be confirmed by the maintainer.

## Assets supplied by locked npm dependencies

| Material | Dependency | Notice |
| --- | --- | --- |
| Provider brand icons | `@lobehub/icons-static-svg` 1.91.0 | MIT, copyright 2023 LobeHub. [Full notice](licenses/lobe-icons-1.91.0.txt), [versioned upstream](https://github.com/lobehub/lobe-icons/tree/v1.91.0). |
| Geist variable font | `@fontsource-variable/geist` 5.2.8 | SIL Open Font License 1.1, copyright 2024 The Geist Project Authors. [Full license from the installed package](licenses/geist-5.2.8.txt). |
| Pi runtime code | `@earendil-works/pi-coding-agent` 1.3.0 and its Pi packages | MIT, copyright 2025 Mario Zechner. [Versioned upstream notice](licenses/pi-1.3.0.txt). This code license is not evidence of a separate logo or trademark grant. |
| Color helper | `khroma` 2.1.0 | The lockfile omits a license field; the installed package includes [this MIT license](licenses/khroma-2.1.0.txt). |
| PNG reader | `png-js` 1.1.0 | The lockfile omits a license field; the installed package includes [this MIT license](licenses/png-js-1.1.0.txt), copyright 2017 Devon Govett. |

Brand names and logos identify their respective products. No endorsement or
ownership of those brands is claimed.

## Items requiring maintainer confirmation

- The remaining authored or adapted agents, skills, references and templates.
- `buffers` 0.1.1: neither its published manifest nor installed files provide a
  license notice. Its declared upstream repository currently returns 404. Do
  not treat an absent field as a permissive license. Resolve provenance or
  replacement before redistributing installed dependencies in a binary release.

The maintainer confirmed on 2026-10-18 that the app artwork was created using a
paid service and is owned by Cwik Technologies LLC. This confirmation covers
`build/icon-source.png`, `build/icon.icns`, `public/icon.png`,
`ui/src/assets/app-icon.png` and the project favicon `ui/public/favicon.svg`.
The service and its terms were not supplied for independent review. This
ownership confirmation does not cover third-party provider logos, including Pi.

## Binary distribution is a separate review

The source export excludes `node_modules` and optional native YouTube tools.
An app build embeds more material than this source snapshot. Preserve each
installed package's license and notice files, and review the actual packaged
payload rather than using a lockfile inventory as proof of binary compliance.

Sharp/libvips brings LGPL and other native-library terms. Consult the installed
`@img/sharp-libvips-*/README.md` and [Sharp's licensing instructions](https://sharp.pixelplumbing.com/install/#licensing)
for the selected platform, including corresponding-source requirements. Existing
parser notices live in `file-parser/THIRD_PARTY_NOTICES.md`.

FFmpeg, ffprobe and yt-dlp are operator-supplied build inputs. Their executable
hashes and versions are recorded by `scripts/stage-youtube-tools.ts`; this does
not establish their license terms or whether an FFmpeg build enables GPL code.
Do not distribute those executables until the selected builds' notices and
source obligations have been reviewed.

## Optional Canvas Office payload and archive handling

OfficeCLI 1.0.157 is an operator-staged native build input, pinned to release
source commit `b65272a18aef891941451705ff93e8a287f3eb72`. Its core is Apache-2.0;
the release declares Open XML SDK 3.4.1, System.CommandLine
3.0.0-preview.2.26159.112 and the self-contained .NET runtime under MIT terms.
The stage command copies the release's `LICENSE` and `THIRD-PARTY-NOTICES.txt`
beside the executable; electron-builder carries both into `office-tools` resources.
Retained copies: [OfficeCLI license](licenses/officecli-1.0.157.txt) and
[upstream component notices](licenses/officecli-1.0.157-third-party.txt).

Canvas uses static HTML only; PDF exporter plugins, native Microsoft Office
automation and remote fonts/scripts are outside this payload profile. The HTML
assembler removes remote assets and the existing frame policy denies network
resources. This source/notice inventory does not replace an audit of the final
signed binary or qualify every upstream plugin or commercial asset.

JSZip 3.10.1 is an exact runtime dependency, available under MIT or GPL-3.0;
Octopus uses it under the MIT option. [Retained upstream license](licenses/jszip-3.10.1.txt).
It normalizes trusted generated Word packages and workbook candidates after the
bounded OOXML preflight; it is not the admission boundary for untrusted archives.
