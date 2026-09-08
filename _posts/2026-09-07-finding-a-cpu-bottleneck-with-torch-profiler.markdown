---
layout: post
title:  "Finding a CPU bottleneck with torch.profiler"
date:   2026-09-07
last_modified_at: 2026-09-07
featured: false
---

I'm two weeks into my GPU computing course and wow. This is the first semester it's being offered, but it's everything I could've asked for and more. I'd been putting off an infra project, a distributed training benchmark suite, because I never got the chance to do deep dives into CUDA/GPU programming. This class is that chance. But like anything else, I have to learn to tread the water before diving in the deep end.

To get myself started, I wrote up a notebook intending to see where CPU/GPU bottlenecks show up in training. This just involved getting a training loop running on a Colab GPU, profiling it, and seeing the results.

### Setup

The loop wasn't anything fancy: it was a 2-layer MLP (784 to 128 to 10, ReLU + dropout) on MNIST, `batch_size=32`, and Adam optimizer.

```python
model = MyNeuralNetwork(input_dim=28*28, hidden_dim=128, output_dim=10)
device = torch.device('cuda')
model.to(device)

loss_func = nn.CrossEntropyLoss()
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)

for epoch in range(3):
    for images, labels in loader:
        images = images.to(device)
        labels = labels.to(device)
        optimizer.zero_grad()
        output = model(images)
        loss = loss_func(output, labels)
        loss.backward()
        optimizer.step()
```

### Profiling the loop

To actually track the CPU and CUDA activity, I wrapped 10 batches in `torch.profiler.profile`

```python
with profile(
    activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
    record_shapes=True,
    profile_memory=True,
    with_stack=True,
) as prof:
    for i, (images, labels) in enumerate(loader):
        images = images.to(device)
        labels = labels.to(device)
        optimizer.zero_grad()
        output = model(images)
        loss = loss_func(output, labels)
        loss.backward()
        optimizer.step()
        if i >= 10:
            break

print(prof.key_averages())
```

My first result:

```
Self CPU time total: 466.943ms
Self CUDA time total: 5.416ms
```

Where a single line in the table accounted for 84% of all CPU time:

```
enumerate(DataLoader)#_SingleProcessDataLoaderIter...   84.34%  393.802ms
```

Everything that was actually traning the model (`aten::linear`, backward pass, `Optimizer.step`) was a rounding error by comparison. 467 ms of CPU time against 5 ms of CUDA time for the same 10 batches. This was exactly what I was looking for: a bottleneck.

The GPU was being starved after finishing its work in a few milliseconds, while the CPU was running data loading synchronously in the main process. This was because I hadn't set the `num_workers` parameter, and its default is 0 meaning no prefetching and no parallelism. 

### Again

`num_workers` controls how many background processes prefetch batches while the GPU is busy on the current one. I looked up the 'standard' number of `num_workers` and tried 4.

```
UserWarning: This DataLoader will create 4 worker processes in total. Our suggested max number of worker in current system is 2...

Self CPU time total: 205.9ms
Self CUDA time total: 4.3ms
```

Then I tried 2.

```
Self CPU time total: 160.5ms
Self CUDA time total: 4.0ms
```

Hm. 

Apparently, the number of workers isn't "free lunch" as my professor describes it. You can in fact oversubscribe the number of cores you have, causing more processes to compete for the same number of limited cores, adding overhead.

### Conclusion

This was a small-scale version of what I imagine a problem that costs real money at production scale looks like; a data pipeline that leaves a GPU idle 20% of the time during a training run can cost a loottt of money in GPU-hours, and it won't show up as an error. Loss still goes down, and training still works.

I'm gonna look into distributed data parallelism next, comparing throughput across GPU counts and connecting that to convergence behavior.