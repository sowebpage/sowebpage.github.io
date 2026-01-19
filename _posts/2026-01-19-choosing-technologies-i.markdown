---
layout: post
title:  "Choosing Technologies I"
date:   2026-01-19
last_modified_at: 2026-01-19
categories: [Data Engineering]
pinned: false
---

Look through any Data Engineering role's job description and you'll be bombarded with the heavy stuff: *Spark, Kafka, Databricks, Snowflake, etc.* It's always enticing (at least for me) to look at these "big data" tools and try to shoehorn them into my projects for the sake of saying I've used them, but I recently learned to adopt a new philosophy: **it's more important that you know what not to use than what you can use.** It sounds trivial, and it probably is to some, but I'm not exaggerating when I say this idea completely changed the way I've learned to understand new technologies.

Instead of looking for the "best" tool to do something, we should look for the tool whose design and limits most closely align with whatever circumstances we have in regards to the data we're working with. To put it simply, there are no perfect solutions that work in every situation; **the process of choosing technologies is simply the process of evaluating tradeoffs.** As a data engineer, one of the most critical steps in this process is identifying your access pattern: OLTP (Online Transaction Processing) or OLAP (Online Analytical Processing). 

My rather broad understanding of the two are OLTP systems run the business, in the sense that they collect the quick transactions that users interact with, typically reading and writing data. This data is then served to OLAP systems which help improve the business. These systems handle the analysis of the data, and involved just reading the data. To get a deeper understanding though, I learned that there are technical differences that make working with certain software for either framework different.

## Point Queries and Scans
OLTP systems are often user-facing, and so we find the access pattern of these systems to be characterized by small fetching/updating of records, or point queries. These are operations that retrieve specific records based on unique identifiers or keys. Queries are to be extremely fast (milliseconds) and the data should represent the latest state because users are waiting on the other end. This also means that as users interact with the system, records are constantly being inserted, updated, or deleted.

OLAP systems are used by analysts and data scientists. This pattern involves scanning a *huuuge* number of records to calculate aggregates. Because the data samples used are so large, queries can take a long time (seconds, minutes). The data represents a history of events, and are typically imported in batches.

## Row-Oriented vs Column-Oriented
Because the access patterns are different, in order to optimize performance, it only makes sense that the physical layouts of the data are different as well.

<img width="2209" height="937" alt="Row-Oriented vs Column-Oriented visual" src="https://github.com/user-attachments/assets/10d1b33c-8256-471d-abda-1fcaac633e85" />

OLTP uses row-oriented databases like PostgreSQL and MySQL, where data is laid out in rows. In a row-oriented database, all columns for a row are stored together on disk and in memory. Because of this, when you fetch a singular row, the database reads one contiguous chunk of data, and gets everything it needs in a single I/O. For row stores, updates are just a rewrite of part of a row.

OLAP on the other hand works better with column-oriented databases like Snowflake and Redshift. These databases store values from each *column* together, instead of each row. This means that there is one disk read per column, so if you need 8 columns from the same row, you'll likely need 8 separate reads. Updating a row in these databases mean modifying multiple column segments and potentially rewriting compressed data. For this reason, column stores are optimized for append-heavy work, not update-heavy.

There are more details as to the indexes these systems rely on, and locking/MVCC, but I feel it might be better to learn more and write separate posts for those topics as opposed to giving my very high-level understanding of it, and hoping it makes sense when I read these later.

## Data Schemas
The way data is modeled also changes to fit the workload at hand. 

Operational databases typically use normalized schemas (which reduces data redundancy). If a user changes their name, for example, you only want to update it in one place to ensure consistency and speed up writes.

Analytical schemas (Star/Snowflake) often accept data redundancy to speed up reads.

## Verdict
By understanding the mechanics of row vs. column and point queries vs. scans, the decision to choose this tool over that tool becomes less about "hype" and more about physics. If you use a column-oriented tool like Snowflake for a high-concurrency application requiring instant updates, you're fighting against the tool's very nature, forcing it to rewrite heavy, compressed column segments for a signle record change. Conversely, using a row-oriented tool to compute decades of sales trends will choke your system as it tries to read through millions of unnecessary fields.

"Knowing what not to use" really just means knowing your system. The "heavy stuff" isn't better because all of the biggest companies use them; it's better because it falls into line with their goals.

## TL;DR
| Feature | OLTP (Operational) | OLAP (Analysis)|
| --- | --- | --- |
| Primary Goal | Run the business (transactions) | Improve the business (analysis) |
| Access Pattern | Point queries (read/write single rows) | Scans (read many rows, few columns) |
| Latency | Milliseconds | Seconds, minutes, maybe hours |
| Storage Layout | Row-Oriented (keep user records together) | Column-Oriented (keep metric data together) |
| Schema | Normalized (reduced redundancies) | Star/Snowflake (optimized for reading) |
| Tools | PostgreSQL, MySQL, Oracle | Snowflake, Redshift, BigQuery |

Until next time.
