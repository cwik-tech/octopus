# Run chat image inputs

Successful image preparation produces metadata and a JPEG preview; extracted
text is not required. For Run session uploads, chat capture parses a private copy
of the admitted original and binds the visual preview into the source revision.
It retains the original file and the existing containment and revision checks.

## Delivery

- Agent tool routes advertise an image in the admitted-document manifest.
  `document_read` returns its visual content only inside the owning turn. Image
  reads do not accept text offsets or PDF page numbers.
  CLI host bridges preserve the image as an MCP `image` content block alongside
  the text result; encoded image bytes count against the bridge response limit.
- Workflow planning attaches the previews to the latest user model message,
  including a structured-response repair attempt. OpenAI-compatible APIs use
  image URL blocks; Anthropic Messages uses base64 image blocks. The selected
  model must support visual input.
- Claude Code helper calls use structured stdin for image input, retaining the
  existing native-tool restrictions. Other helper CLI transports explicitly
  reject image inputs. This restriction does not change their existing MCP tool
  routes.

This correction covers Run session uploads. It does not add image delivery to
selected project references or Team/Create upload pipelines. Supplying a picture
does not establish complete document-review coverage.

## Limits

The parser's existing preview has a maximum edge of 1200 pixels. Image inputs
accept JPEG, PNG, WebP and GIF MIME types; the captured preview is JPEG. This
does not preserve full-resolution detail or animated frames.

`contracts/model-image.ts` bounds each encoded image at 2,800,000 base64
characters, helper turns at 16 images, and total decoded helper input at 8 MiB.
Native document tools also retain the tool loop's existing result-size limits.
`domains/document-access/document-request-budget.ts` reserves 4096 estimated
tokens per validated visual input, in addition to the existing text envelope
budget. Base64 strings in ordinary text remain charged as text. These are host
bounds, not a prediction of provider billing or model-specific vision costs.

## Verification contracts

The flow and test mapping are in
[document consumption](../flows/document-consumption.md), DC-08.
