---
layout: post
title:  "Choosing Technologies II"
date:   2026-02-01
last_modified_at: 2026-02-01
categories: [Data Engineering]
pinned: false
---

As I’m reading my notes, I’ve come to the realization that this series is going to be all over the place, so I’ll try to keep it coherent, but I can’t make any promises.<br><br>

We last talked about OLTP vs OLAP databases, and why each of them work for some systems and not others. This time, we’re going to talk about data modeling. I was hesitant to include this in the series, since I kinda wanted to write about this separately, but it includes some tradeoffs that overlap with this topic, so I’m including it.<br><br>

## Data Modeling

Data modeling is the process of deciding how data is structured, stored, and related in databases in a way that is correct for the business, efficient for the system, and easy to use for us humans. We’re answering questions like:<br><br>

- What things do we store?
- What properties do they have?
- How do they relate to one another?
- What rules apply?

<br><br>It’s almost like we’re drawing a blueprint. We aren’t writing any queries yet, but we’re deciding what everything looks like in data form. <br><br>

What I’ve just described is the **conceptual layer** of data modeling. It’s the highest-level of data modeling, where the goal is to accurately capture reality.<br><br>

Next up is the **logical layer**, where we start to translate our concept of the data into actual structure. If the previous layer was the ‘what’, this is the ‘how’. I think what made it difficult for me to understand this layer was the fact that I attributed it to the physical layer in the sense that I thought this involved choosing the DBMS and making other physical data storage decisions. All this layer is, is building that bridge between the conceptual model and the physical model. Here, we define tables, entities, relations, etc., with a goal of creating a correct and normalized schema.<br><br>

Lastly, we have the **physical layer**. Now it gets concrete; we’re deciding the data types, which version of SQL we use, indexes, storage details and more. We want to tune our system and make decisions based on the performance, costs and capabilities	 of our tech.<br><br>

This is how I’ve learned to understand the *process* of data modeling. The *strategy* we choose during this process involves the idea of normalization and denormalization.<br><br>

## Normalization	vs Denormalization

To normalize is to break apart, and to denormalize is to put together. It’s sort of confusing if we just look at the words, but it makes a bit more sense the more we look into it. **Normalization** is all about reducing redundancy and improving data integrity. We’re structuring the database in a way that dependencies are minimal by dividing it into separate tables and defining relationships between them. **Denormalization** on the other hand, is used to increase performance by adding redundancy. Sounds ironic, but by combining data from multiple tables and putting it into one, we reduce the need for complex joins and queries at the cost of data duplication and maybe some inconsistencies.<br><br>

The decision to normalize or denormalize typically starts at the logical layer and ends at the physical layer. Remember, In the conceptual layer, we’re just letting the data be known. We don’t really care about how it’s stored just yet. When we get to the logical layer, though, we decide whether we want to keep our data clean and separate the tables, or make the queries fast. At the physical layer, you create the keys, and build the tables using the logic for either a normalized or denormalized model.<br><br>

Normalization is usually applied in OLTP systems. Think about it, you have many small and narrow tables, and because you prioritized the logical integrity (no duplication), your physical layer now requires complex join statements. Don’t flinch at the complex joins. OLTP system queries usually look for a specific record. Because  the tables are normalized, the database can find that specific row in memory almost instantly, so it is still very fast. We accept the tax of the complex joins because our queries are usually small and specific.<br><br>

Denormalization is usually applied in OLAP systems. Here, you have a huge (or “wide”) table with everything in it. You want to intentionally break the rules of the logical layer to optimize the physical layer for performance and cost on systems like BigQuery or Redshift. We can’t quite afford joins here like we could in normalized databases because joining millions of rows with millions of other rows would take forever, or maybe even crash. So we just flatten it all out ahead of time.<br><br>

So a better way to put it would be normalization is about organizing the data, whereas denormalization is about utilizing the data.<br><br>

This has opened up a new can of worms like snowflake vs star schemas and data integrity vs query speed, but that is for a later date. Today, we talked about data modeling being the bridge between a business problem and our technical solution. Whether we keep it normalized in a PostgreSQL instance or flatten it all out in a BigQuery warehouse, the goal remains the same: **make our data useful**.<br><br>

Ciao.


