# Last Preview Text

A ComfyUI node that shows the text from the previous run alongside the text from the current run, so you can compare them without digging through the queue history. Text can be shown as plain text or as Markdown.

It's useful for anything that changes from run to run, such as:

- the rewritten prompt from a prompt enhancer or LLM, to see exactly what it produced
- the prompt picked by a wildcard or random prompt node
- the seed used, so you can see which seed made the last result and go back to it
