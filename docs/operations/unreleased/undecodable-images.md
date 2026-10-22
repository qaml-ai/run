### Recover from damaged images

Damaged or incomplete images are replaced with an omission notice before they
reach the model, including images already in an agent's history. The saved
history and files are unchanged.

If a provider still cannot read an image, the runtime retries once without
images and keeps them omitted for the rest of that turn. The next turn can use
images again.
