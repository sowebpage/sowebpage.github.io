---
layout: post
title:  "A cache, then a batch"
date:   2026-10-15
last_modified_at: 2026-10-15
featured: false
---

Last time, the tokens matched and the continuous batch still paid for a rectangle. `cache_cat` glued the live caches every step, and a longer arrival rewrote every resident key through `cache_pad_left`. The copy was the cost of one shared length. Now, each sequence keeps its own length on a shared pool of pages, so admitting someone doesn't restack everyone else.

### Why pages

In the dense path, one sequence's past is one contiguous tensor per layer, and a batch of sequences become one wider rectangle where every row is stretched to the same `T`. That stretch is what made the long waiter shove a pad column onto France. The keys didn't need to move. The layout is what demanded they all share a width.

With paging, storage is a pool of fixed-size chunks. A sequence doesn't own a growng slab but a list of chunk ids, in the order its tokens were written. Length lives on the sequence. Width of the pool never has to equal anyone's `seq_len`. Two sentences can sit in the same pool at different lenghts, and neither one has to be rewrittenwhen the other shows up.

### In the pool

The check uses eight pages and four slots per page:

```
[layers, pages, 3, block_size, 64]
```

Thirty layers because SmolLM has thirty blocks, and each block needs its own past. Three heads because that's what GQA stores (keys after RoPE, values as projected); the copy out to nine heads still happens at score time, same as the dense cache. Head dimension is 64. Four is just a small block size so a short prompt spans more than one page and the free-list behavior shows up.

A sequence on that pool is not another copy of the weights:

```
{"pool", "blocks", "seq_len"}
```

`blocks` is the physical page ids in logical order: first page holds tokens 0-3, second 4-7, etc. `seq_len` is how many of those slots actually have a real token written. `free` on the pool starts as `0..7` and is the only place new page ids come from.

The page list is shared across ALL thirty layers. You don't allocate "page 2 for layer 7" separately from "page 2 for layer 0." Token 5 of the sentence is token 5 in every layer's past. So when the sequence says "I hold pages `[4, 5, 1]`," that means the same three physical pages, indexed by layer when you read or write. What differs per layer is the contents of those slots, not which pages the sequence claims.

`reserve_pages` runs once per forward, before the layer loop, and pops from `free` until `blocks` covers `ceil(total_len / block_size)`. It's driven by how many tokens the sequence will have after this step, not byh how many layers exist. If you reserved inside the layer loop, you'd either pop the same need 30 times or create a per-layer free list that this design doesn't really have. The pool's job is to have "enough slots for this many tokens"; the layer loop's job is to "fill those slots for every block".

### Writing and reading without a rectangle

The paged forward still receives the whole id list, because that list is what gets decoded and compared later. Inside, it only embeds the unstored tail, using `seq_len` as past, the same split the dense cache used (`cache[0][0].shape[2]`). Positions for RoPE are `past, past+1, ...`, not a fresh `0`. A follow up token numbered from zero would be rotated as the start of the sentence, and every later score would be reading a key that doesn't belong there.

For each layer we gather what's already written for this sequence, run the same `llama_attention_cached` as the dense path, then write only the new key/value tail into the pool. Absolute position `p` lands at page `blocks[p // block_size]`, slot `p & block_size`. The write takes the new tail only; attention hands back the full `K/V` after the cat, so the slice is `[:, :, past:]`. `seq_len` bumps once after all layers finish. If it bumped inside the loop, layer 1 would think token layer 0 just wrote was already "past" and the write index would drift.

Gather is the inverse. Index `pool[layer, blocks]`, reshape into one time axis, then cut to `n` so empty slots on a page reserved for this step's new tokens don't show up as fake keys. The order of `blocks` is the order of time. If Germany ends up with `[4, 5, 1]` and you sort that list before gathering because it looks cleaner, you read page 1 before paeg 5 and the sentence's history is scrambled. The equal against a dense generate goes false. That list is not a set of owned pages but a timelime.

### One sequence, then two on the same pool

Prefill against the uncached forward is `0.0`. `seq_len` is still 0, so nothing is gathered yet and we're just scoring the prompt. After five prompt tokens the blocks are `[0, 1]` and `seq_len` is 5 (second page half full). Ten new tokens through `generate` match a dense cached generate on the same ids. At the end, blocks are `[0, 1, 2, 3]` and the `seq_len` is 14. The tenth sampled id is appeneded and never run through the model (just like before), so the forwards are 5 + 9 and the last page has two live slots.

Then both sequences share one pool. France runs ten new tokens, Germany four. Both match their dense solo runs: France holds `[0, 1, 2, 3]` and Germany `[4, 5]`.

`release_pages` puts Frane's ids back onto `free`, sorts `free` so the next `pop(0)`is the lowest id again, and clears France's `blocks`. Germany's numbers stay put. The slots France used still contain France's old keys until something reserves those pages and overwrites them. That's ok though because nothing gathers a released sequence's blocks anymore, and a new sequence that takes page 0 will write over whatever was there.

`"The cat"` prefills into a returned page and takes page 0. Germany writes one more new token. Its ninth key needs a third page; page 0 is gone, so it gets page 1:

```
germany [4, 5, 1] 9 free [2, 3, 6, 7]
```

`[4, 5, 1]` looks off if you're expecting physcial ids to be sorted. Logically, though, it is. That's the whole point of paging.. the physical location and time order are allowed to disagree.

### Continuous batching without shoving the neighbors

The dense continuous batcher stays in the file. A second loop runs on the pool and cap is still two live slots. Admitting a request means allocating a fresh sequence on the pool, prefilling that prompt alone, sampling the first token, and either keeping the slot or releasing those pages immediately if the budget was 1 or the first token was eos. Nobody already running gets a pad column glued onto their keys. Their `blocks` lists don't change when a waiter arrives.

The shared decode step only stacks the last id from each live slot. The batch forward gathers each sequence's past independently, then left pads those temporary gathers to the widest live length so `llama_attention_cached` still sees one rectangle and can use `pad_lens` the way it already does. The pad is on the gather, for that call, it's not written back into the pool. France's pages stay France's pages when a seven-token waiter sits down next to it.

So the print line tracks length instead of pad:

```
batch [0, 1] gen [1, 1] len [5, 2]
batch [0, 2] gen [2, 1] len [6, 5]
...
batch [0] gen [5] len [9]
```

So the same three requests as last time and a short and long waiter. Both match a serial dense `generate` at each request's own budget. The long waiter still comes out `Once upon a time there was a little girl named Lily`. When the loop is done, `free` is the whole pool again and every page returned.

### Present

What went away is the resident rewrite. Admitting a longer sequence no longer means `cache_pad_left` oveer every live row. Each sequence's history stays in the pages it already owned.

What didn't go away is a gather. Before attention, pages are still pulled back into a dense `[1, 3, T, 64]` (or a padded batch of those). That copy is real; a paged generate on my laptop isn't expected to beat the dense cached path, and timing the whole script would time the loading weights (definitely not coping). The win at this stage of the projec is the memory shape: lenghts are per sequence, finished work goes back on the free list, and a survivor's block ids don't move when a neighbor arrives or leaves.

Scoring the pool without gathering it into a rectangle is a whole new problem. That deals with kernels, which is next up.

Until then.