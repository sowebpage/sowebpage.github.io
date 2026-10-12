---
layout: post
title:  "A cache, then a batch"
date:   2026-10-12
last_modified_at: 2026-10-12
featured: false
---

Last time, I got the scores to match. There was a single prompt for a GPT-2-small, every block was made from scratch, and the biggest gap in the score vector was about 0.0002. `' the'` stayed first. Since then, I've gotten a few things done.

### New model

The GPT-2 path is still in the file and still matches. The rest of the work was moved to a small Llama, SmolLM2-135M, because that model reads with 9 query heads and stores 3 key/value heads. I learned that GPT-2's architecture is dated, so I switched to this Llama-style model so I can implement the architecture modern engines actually deal with. This, however, is not the end all be all. 135M parameters is about the same size as GPT-2, about 270 MB in fp16. The weight read per decode step is on the order of 90 microseconds at 3 TB/s. It's deeper than GPT-2 small, meaning there are more layers and therefore more kernel launches per step. The only real upside to choosing this model is because of the architecture. For now, this is small enough to iterate fast, and it's easy to compare against the HF reference. Later, I plan on using a ~1B Llama-family model for benchmarking.

### Loop that rescores everything

The forward from last time returns one score vector for whatever ids it's given. `generate` asks it again after each chosen token. It takes the highest score, appends that id, and calls the forward on the whole list:

```python
next_id = torch.argmax(logits)
ids = torch.cat([ids, next_id.view(1, 1)], dim=1)
```

It takes the highest score only, greedy bastard. With no cache, every call starts over at the first token. Ten new tokens on this prompt means the forward sees a sentence of length 5, then 6, 7, …, 14. 95 token forwards total (`5 + 6 + … + 14`).

On GPT-2, those 10 tokens match `model.generate(…, do_sample=False)` with `torch.equal`. The decoded string is `The capital of France is the capital of the French Republic, and the capital`. `' the'` really was the next piece. The loop stops on the eos id, `50256`, or when the budget is spent. This prompt doesn't stop early.

### Same five pieces, a different block

SmolLM's tokenizer splits the prompt into the same five pieces `The`, `capital`, `of`, `France`, `is`. These ids aren't the GPT-2 ids. Its vocab has 49,152 rows, and reusing the GPT-2 row would score a different piece.

The block is still the same shape as last time; a correction is computed and added and the numbers already in the residual stay there.

Last time, each token added a row of `wpe`. This time, the token embedding is the whole lookup, and the position is a rotation of the query and the key:

```python
inv_freq = 1.0 / (theta ** (torch.arange(0, head_dim, 2).float() / head_dim))
freqs = position_ids.float()[…, None] * inv_freq
emb = torch.cat((freqs, freqs), dim=-1)
```

`rope_cos_sin` builds that rotation from the position index and a base of `100000`. `rotate_half` is the particular turn these weights were trained with: the 64 numbers in a head are cut into two chunks of 32, the chunks are swapped, and one of them is negated. If we turned neighboring pairs instead, it'd be a different model. The rotation is applied to the query and the key. The value is what gets handed, and it carries no position. On the full forward the positions are `0, 1, 2, 3, 4`.

The rescale is `rms_norm`. It multiplies each row by a learned weight and divides by the root-mean-square of that row, plus `1e-5` so a flat row doesn't just die. GPT-2's `layer_norm` also subtracted the average and added a bias. This one actually does neither. It runs before attention, before the MLP, and once more at the end.

The weight matrices are stored as `[out, in]`, so the multiply is `x @ W.T`. GPT-2 stored them the other way, where the multiply was `x @ W`. Query, key, and value are the three matrices. Nine query heads, three key heads, three value heads, and 64 numbers each. Before the score, `repeat_kv` copies each key head and each value head three times, so the nine queries have something to read. The stored width of the keys and values is `3 * 64 = 192`. A view that expects nine key heads is the wrong tensor.

The MLP is `llama_mlp`. Two matrices read the same vector, and one result is bent with SiLU (the curve these weights expect) the way `gelu_new` was the curve GPT-2 expected. The two results multiply element by element, and a third matrix brings the width back down:

```python
hidden = silu(x @ W_gate.t) * (x @ W_up.T)
```

The MLP reads the output of the norm that follows attention. Feeding it the residual stream still runs, but the scores come out wrong.

The last row is one of the few things done the same way as last time (it's scored the same). The output matrix is the token embedding:

```python
x[0, -1] @ lm_head.weight.T
```

One load detail decides whether the multiply runs at all. The checkpoint on disk is float32, and mixing them into the query and the key promotes those to float32. The value is never rotated, so it stays bfloat16, and the matmul refuses the two dtypes. The load is `dtype=torch.float32`.

Against HF, the biggest gap in the score vector was about `0.00006`. The ten greedy tokens match `llama.generate`.

### Keys and values kept

The rereading loop is there so there's something to remove. A new token only needs its own query. The keys and values of the tokens already scored can be stored.

`forward_llama_cache` keeps a list of 30 pairs, one per layer. Each tensor is `[batch, 3, time, 64]`. The 3 is the key and the value heads: keys after the rotation, values as projected. The copy from 3 heads to 9 happens when the new keys are appended, so the stored tensor stays the narrow one. Queries are recomputed, belonging to the new token.

The forward still gets the whole id list because that list is what gets decoded and compared. It then keeps only the tokens that aren't stored yet:

```python
past = 0 if len(cache) == 0 else cache[0][0].shape[2]
new_ids = ids[:, past:]
```

An empty list is a real cache, just with nothing stored yet. The check in `generate` is `cache is None`. An empty list is falsy in Python, and doing `if cache` would treat the start of a cached run as "no cache" and reread the whole sentence. Each `generate` starts from a fresh `[]`. A reused list already has a length, and the next prompt is then sliced as if it were a continuation of the last.

The positions are kinda the same. A new token is numbered from `past` and not 0. A follow-up token numbered 0 is rotated as the first position, and its key is wrong for the rest of the sentence.

The mask becomes a rectangle. On the prompt, the new length and the total length are the same, and the mask is the triangle from last time: a token can read itself and everything to its left. On a one-token step, that one query may read every stored key.

The function returns a new list and doesn't append onto the list it was given. The scores come back as one row per sentence in the batch. A single sentence is a batch of 1.

The first call processes 5 tokens and the next nine process 1 each. 14 against the 95 above. On my laptop the uncached loop took about 0.30s and the cached loop about 0.18s, roughly a 1.6x speedup. The seconds move from run to run whereas the token match doesn't. Both paths still walk 30 layers in Python on every step, and at this length that walk costs as much as the matmul. A longer budget would widen the gap as the tokens are already the same.

One decode step against the uncached forward, on the same 6 ids, lands around `0.00006`. The stored keys came from a 5-token multiply and the reread is a longer one. The chosen id still matches. A gap near 1 would mean the position or the mask is wrong.

### Four prompts, one rectangle

I set four prompts with 5 tokens each:

```
The capital of France is
The capital of Germany is
The capital of Spain is
The capital of Italy is
```

Stacked, the ids are `[4, 5]`. One forward returns scores `[4, 49152]` and a key cache `[4, 3, 5, 64]`. Row 0 against the France scores of a single-sentence forward sits about `0.00002` away, the same scale as the earlier match. 

`generate_batch` then takes 10 tokens from all four rows together. A row that hits the eos id stays in the tensor. The loop marks it finished and keeps writing that id into it, so the tensor stays `[4, T]` and the other rows still have a batch to sit in. A prompt that only needed 2 tokens occupies a slot until the prompt that needed 10 is done.

Each row, cut to the length of its own solo run, matches `generate` on that prompt alone. The four solo runs took about `0.80s`. The batch took about `0.37s`. The weights move once per step and four rows use them. About 2x, for the same reason the cache was 1.6x. The walk over 30 layers in Python is still there. 

### Short rows get padded on the left

France and Germany stay 5 tokens. `The cat` is 2 having only `The` and `cat`. New tokens are appended on the right, so the pad goes on the left. A pad on the right would put the next real token in the middle of the row, and the position counter would count the pad as content.

```python
n = width - r.shape[0]
r = torch.cat([torch.full((n,), pad_id, dtype=r.dtype), r])
```

`pad_lens` comes out `[0, 0, 3]`, the number of pad ids on the front of each row. The pad id is eos, and that id is 0, which is also the beginning-of-sequence id. Scanning the row for zeros can't find the pads. The count comes from the actual tokenizer lengths.

The position of a column is `column - pad_len`, floored at 0. The three pad columns and the first real token of `The cat` all sit at position 0. The mask then forbids using a pad column as a key. A token can read the real keys at its own position and to its left. Slowly but surely noticing there's a bunch of parallels with all of this stuff *badoom tsss*.

The blocked scores are filled with the most negative finite value of that dtype. A pad position can have every key blocked. Softmax-ing over a row of true negative infinities returns NaN, and that NaN is written into the value at the pad position. A later real token is told to put weight 0 on that position, and `0 * NaN` is still NaN, so the bad value spreads. The finite fill stays a real number, and zero times a real number is zero.

France against the single-row scores is again about `0.00002`. `The cat` against its own single-row scores is about `0.00005`. The generated ids, with the pad columns sliced off, match the solo run on all three rows.

### A finished row leaves

The fixed batch holds the short request until the long one finishes. `generate_continuous` uses the same forward and changes who's in the tensor. The cap is 2 live rows. Three requests now wait: France with a budget of 6 new tokens, `The cat` with a budget of 2, and a third request behind them.

France and the cat run together. The cat hits its budget and is removed. The waiting prompt is scored on its own first, its first new token is chosen, and then it is lined up with whoever is still there. For every live row, the cache holds every token except the last id. That last id is the one the next forward still has to score. Cache length `C`, id list length `C + 1`.

One forward needs every row's cache to have the same length. `cache_pad_left` comes to the rescue and sticks zero columns on the front of the shorter one.

The short arrival is `The capital of Germany is`, 5 tokens. France's cache already has 6, so the arrival gets one extra column. The first step they share prints:

```
batch [0, 2] gen [2, 1] pad [0, 1]
```

France has produced 2 tokens and has no pad. The arrival has produced its first new token and has a pad of 1. After it's done, France is alone, still with no pad.

The long arrival is `Once upon a time there was a` with 7 tokens. France is now the row that grows. One pad column is stuck on the front of France's keys, values, and ids, and France's pad goes from 0 to 1. The first shared step similarly prints:

```
batch [0, 2] gen [2, 1] pad [1, 0]
```

The arrival then finishes, and France runs the rest of its budget alone, still carrying that pad. The mask still refuses the pad column. The decoded arrival ends up being:

```
Once upon a time there was a little girl named Lily
```

Each request's ids match a solo cached `generate` of that request's own budget. Both arrangements here, the short arrival and the long one. Fascinating stuff mate.

### The copy

So the tokens match, and the clock stays next to three solo cached runs. About `0.27s` solo and `0.32s` continuous for the short arrival. About `0.30s` and `0.28s` for the long one.

`cache_cat` glues the live caches into a single batch tensor on every step, and that glue copies the history. When the arrival is longer than the rows already running, every one of their keys and values is copied again to make room for the pad column. Our rectangle lives to see another day. The copy is the cost of keeping one shared length for every row. A cache where each sentence keeps its own length so admitting someone doesn't mean restacking everyone else is what's up next.

Until then.