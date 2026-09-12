# Display icons

Yoto display icons are 16x16 images shown against a dark background. Prefer a
public Yoto icon when one clearly represents the track.

## Public icons

Search by one concrete subject rather than the complete track title:

```bash
yoto-cli icons --tag animal
yoto-cli update-icon <card-id> <entry-index> --media-id <media-id> --dry-run
yoto-cli update-icon <card-id> <entry-index> --media-id <media-id>
```

`entry-index` is zero-based. Fetch the latest card immediately before mapping
indexes. The wrapper adds the required `yoto:#` prefix to a bare media ID.

## Custom icons

Build the final sprite deliberately at 16x16 rather than treating a downscaled
illustration as finished artwork. Use:

- PNG in RGBA mode with transparent background
- one recognizable subject and a bold silhouette
- a small flat palette with no visible pure-black pixels
- no text, gradients, or decorative detail that disappears at display size

Validate and create a nearest-neighbor preview on black:

```bash
yoto-validate-icon icon.png --preview icon-preview.png
```

Inspect the preview. Technical validity alone does not prove that the subject
is recognizable. Upload and assign only after both checks pass:

```bash
yoto-cli upload-icon icon.png
yoto-cli update-icon <card-id> <entry-index> --media-id <returned-media-id>
```

For a batch, use a manifest and preview it first:

```bash
yoto-apply-icons <card-id> icons.json --dry-run
yoto-apply-icons <card-id> icons.json
```

The applied icon must appear on both the chapter and its first track when the
card is fetched again.
