---
layout: post
title:  "A naive forward pass on GPT-2-small"
date:   2026-10-03
last_modified_at: 2026-10-03
featured: false
---

Inference serving and runtimes are about making a recipe fast without changing the answer. The recipe here is the forward pass. Being a recipe, working in inference runtime/serving and distributed training rarely ever involves inventing it. People in these jobs only have to know it well enough to notice when a shortcut changed the result. So that's what brings me here.

Today I wrote a naive forward pass on GPT-2-small, as a baseline. Naive meaning one prompt, frozen weights, every block recomputed from scratch, plain matmuls in fp32, and no cache. Nothing was trained.

The prompt was fixed: "The capital of France is". The tokenizer doesn't necessarily see letters; It has a list of 50,257 pieces, and a leading space is part of the piece, so the ids were `The`, ` capital`, ` of`, ` France`, and ` is`, giving a shape `[1, 5]`.

Given those five pieces, I asked Hugging Face for the score of every vocab piece as the next one. These are raw scores, before a softmax:

```
-100.2498 ' the'
-100.8175 ' now'
-100.8555 ' a'
-101.2102 ' France'
-101.2143 ' Paris'
```

GPT-2-small's favorite is `' the'`, then `' now'`, `' a'`, `' France'`, `' Paris'`. `' Paris'` sitting in fifth is the model's own behavior, and our goal was to match it.

### The lookup

```python
pos = torch.arange(ids.shape[1])
x = wte[ids] + wpe[pos]
```

`wte` is a table with a row of 768 numbers per vocab piece. `wpe` has a row for each position the model can sit in, 1,024 of them, and this prompt uses the first five, 0 through 4. Adding them gives each token a vector that says both which piece it is and where it is. `x` is now shape `[1, 5, 768]` meaning one sentence, five tokens, 768 numbers each.

### One block adds two corrections

There are 12 blocks, and each one does the same thing to `x`. It computes a correction and adds it. The numbers already in `x` stay there. Block 0 writes both adds out in full. The loop over the other eleven is those same two adds:

```python
for block in model.transformer.h[1:]:
    x_hat = layer_norm(x, block.ln_1.weight, block.ln_1.bias)
    delta, _ = attention(x_hat, block.attn.c_attn.weight, block.attn.c_attn.bias, block.attn.c_proj.weight, block.attn.c_proj.bias)
    x += delta
    h = layer_norm(x, block.ln_2.weight, block.ln_2.bias)
    x += mlp(h, block.mlp.c_fc.weight, block.mlp.c_fc.bias, block.mlp.c_proj.weight, block.mlp.c_proj.bias)
```

The first correction is `x += delta`, tokens exchanging information. The second is `x += mlp(...)`, each token reworking its own 768 numbers, with no look at the others.

### Rescale, both times

`layer_norm` runs on each token's 768 numbers separately, taking the average, subtracting it, and dividing by the spread. `unbiased=False` means that spread divides by 768, which is the reduction as it stands. `eps=1e-5` keeps a perfectly flat row from dividing by zero. The learned `weight` and `bias` then stretch and shift the row the way this model wants.

After a few blocks, some rows would otherwise be huge and some very small, and the multiplies after that get a bit messy. The rescale puts every row on a comparable scale before the real work. It runs before each correction, and once more at the end.

### Tokens reading left

`c_attn` is one multiply that turns 768 numbers into 2,304, then splits them into three views of 768: query (what this token is looking for), key (what this token offers as a label), value (what it hands over if another token looks at it).

Each view is split into 12 groups of 64, and each of these twelve reads are able to pick up a different relationship. A score is how aligned the query is with that token's key. Multiplying by `1/8` (`64 ** -0.5`) keeps those scores from getting so large that one token takes the entire mix.

```python
scores = (q @ k.transpose(-1, -2)) * (head_dim ** -0.5)
future = torch.triu(torch.ones(T, T, dtype=torch.bool), diagonal=1)
scores = scores.masked_fill(future, torch.finfo(scores.dtype).min)
weights = torch.softmax(scores, dim=-1)
```

The mask is the rule that makes this a left-to-right model. The token at index 3 may read positions 0, 1, 2, and itself. Later positions get a huge negative score, so one `softmax` turns that score into a share of about zero, and the legal shares add up to 1. The first token is only allowed to read itself, so its share on itself is 1 and the rest of that row is 0.

The 12 groups are glued back into 768, one more multiply mixes them, and that vector is the first correction.

### Each token alone

The MLP multiplies 768 to 3,072, bends the wide vector, multiplies 3,072 back to 768, and that is the second correction. The bend is `gelu_new`; largely negative numbers get pushed toward 0, largely positive numbers pass through, and the constants in that function are the exact curve this checkpoint was trained with. A different curve would be a different model. This is the one formula in the file that looks like actual textbook math, and its job is to use the same bend the weights expect.

### The only row that matters

After all 12 blocks, one last rescale with `ln_f`, and then:

```python
my_logits = x[0, -1] @ wte.T
```

`x[0, -1]` is the last token, `is`. The output matrix is the same table as `wte`: the checkpoint ties them. Each of the 50,257 scores is how aligned that last row is with one vocab piece's embedding. Each earlier row is also a next-token guess, for the prefix that ends at that position, and those next pieces are already in the prompt. Only the last row is a guess that is not already sitting in the input.

Then my top five matched the reference. The biggest gap anywhere in the score vector was about `0.0002`. The gap between `' the'` and `' now'` is about `0.57`, so the ranking is stable. The leftover gap is rounding from doing the multiplies in a slightly different order. The reference scores were computed with Hugging Face's default attention kernel. The handwritten path is a plain matmul. Same recipe, different ending digits.

Until next time.