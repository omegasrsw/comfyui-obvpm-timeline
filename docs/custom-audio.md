# Custom audio for lip sync

Restart ComfyUI and refresh the browser after updating the pack. The Timeline
now has an audio row below the video strip. Click **+ audio** or drop an audio
file there. One soundtrack can be placed per Timeline; it is saved with the
workflow, while the uploaded file lives in `ComfyUI/input/timeline_audio`.

The supplied timeline workflow already has the necessary wires:

1. Timeline **pin_specs** → H3 MCtx Apply Pins **pin_specs**.
2. H3 audio VAE → Apply Pins **audio_vae**.
3. Apply Pins **latent** → the generation sampler's latent input, and
   **conditioning** → its guider.
4. Sampler output → H3 MCtx Trim and Save Video **samples**, with the decoded
   images and Apply Pins' **pins** connected as usual.

No manual Load Audio / VAE Encode Audio / AV concatenate chain is needed.
Apply Pins performs those audio operations using the selected generation's
actual frame count. Removing the track restores the existing generated-audio
behavior. Older workflows without an audio row value behave as before.

## Transcribe the upcoming chunk for its prompt

Connect Timeline **chunk_audio** → your ASR node's **audio** input, then
insert the ASR transcript into the video prompt. This AUDIO output is
available before prompt conditioning or VAE encoding, so it creates no
circular dependency through Apply Pins.

It contains exactly the source waveform that will be encoded for the next
generation: the full raw chunk, including head/tail context and both bridge
overlaps, source offset, and any silence padding. ASR timestamps are relative
to the beginning of that raw chunk. Apply Pins reuses this same waveform
rather than loading and cropping another copy. Keep Timeline **length**
connected to the generation latent's length; a mismatch is rejected before
audio encoding.

**chunk_audio** is `None` when no custom track is selected or when the
Timeline is in upscale mode. Bypass the ASR branch in those cases. The
existing four output sockets keep their indices; **chunk_audio** is appended.

## Audio row controls

- **place s** sets the audio anchor on the original timeline. Dragging the
  waveform changes this value at video-frame precision.
- **source s** is the source-file time at that anchor. For example, `67`
  starts the initial take from 67 seconds into a song. A prepend can then
  use the earlier part of that same file.
- **length s** limits the audio after the source offset. `0` uses the rest
  of the file. Before the beginning or after the end of the available
  source, the generation window is padded with encoded silence.
- **lip sync** controls audio denoise during sampling, default `0.5`.
  The model can resample the audio while producing mouth motion. The pack's
  Save and Trim and Save nodes always write the original waveform and
  store the supplied audio latent for later continuation. `0` holds the
  supplied audio latent throughout sampling.
- **▶** auditions the source from the selected offset. The shaded waveform
  region follows the existing next-run placement indicator.

## Chunk and bridge timing

All generation ranges use the 24 fps H3 frame grid and the **resolved** pin
recipe, after source cuts and window snapping. An extension begins its raw
audio window inside the previous clip's overlap. A prepend includes the
destination overlap at its tail. A bridge includes both. The existing
handover/trim calculation removes the scaffolding from picture and sound
together, including soft arrival ramps.

Audio sample boundaries are calculated from absolute positions, avoiding
rounding drift across a chain of chunks. Saved takes record their source
audio coordinates in their sidecars. Inserting a prepend therefore keeps
the existing clips on their original part of the soundtrack; the audio row
adjusts its display to those saved coordinates. Changing the file, source
offset, placement or duration deliberately starts a new audio mapping.

For a bridge, both pinned sources must agree on the raw audio window. If
they do not, Apply Pins reports the required raw frame count and duration
before sampling. Adjust the gap or generation length to a legal H3 length.
Moving existing clips or cutting arbitrary amounts of speech cannot always
be joined by one continuous source-audio window. A wrap bridge to the start
of a non-looping soundtrack likewise cannot satisfy both audio anchors.

Existing clips keep the sound and mouth motion they were generated with;
adding an audio file affects subsequent generations. To maintain lip sync
through a whole sequence, start its generations with the intended track.
The upscale branch continues to use the saved audio latents as before.

Use the pack's Save or Trim and Save node for automatic original-audio
delivery. Third-party savers and latent transformations that discard extra
latent metadata require explicit source-audio wiring; they cannot recover
the original waveform from the denoised latent alone.
