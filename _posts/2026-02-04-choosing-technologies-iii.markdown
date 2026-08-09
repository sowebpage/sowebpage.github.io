---
layout: post
title:  "Choosing Technologies III"
date:   2026-02-04
last_modified_at: 2026-02-04
featured: false
---

Impedance mismatch isn’t just a boundary condition issue in electrical engineering. In databases, it describes the friction between how application code is usually written and how relational databases store its data.

Today I wanted to learn more about NoSQL and why exactly one would want to use it, so here we are. This marks the threequel of my Choosing Technologies series, and I’m thinking of writing other entries in between these because as I get deeper into this, the more holes I find in my knowledge, and I fear this will never end.

Anyway...

## Relational vs Document / SQL vs NoSQL

As I mentioned before, impedance mismatch in databases are the discrepancies in the way we write our code and how our (relational) databases store our data.

Typically, when we write object-oriented code, it involves nested objects within each other. For example, say we were an e-commerce store holding customer data:

```py
class Item(id: int,  name: str)
class Order(id: int, ship_addr: str, items: List[Item])
class Customer(name: str, order: List[Order])
```

It’s a nice self-contained document that flows naturally with our code, but relational database hates nice things, and wants flat 2d structures, or tables. So to save this data into a relational database, we as developers would have to rip it apart and create separate tables for orders, users, items, and build the connections between them. Then when you want to read this data again, you’ll have you join and glue it back together again. Impedance mismatch. It’s a pain for us developers as it calls for extra code, and may cause unnecessary problems in the future.

NoSQL databases come around and say, “Hey, stop shredding. Just give it to us, and we’ll hold it for you no problem.” With NoSQL databases, you can have those nested objects and save it directly as a JSON object/document into the database, effectively solving the impedance mismatch problem.

## But why does SQL still dominate?
While it’s great that we can use these complex structures, NoSQL queries are compute-intensive and better suited for OLTP systems and not OLAP. Imagine you have one million users stored in your database in these nice contained JSON documents, each with nested objects. One day, your CEO walks in and asks you to find the total revenue of all orders last month that included a blue shirt. Remember, that blue shirt info is buried in the nice and comfortable nests in their contained documents. This means your engine would have to open every user document, scan them, look at the items, etc. Just a very expensive operation, and the queries would be overly complex.

In the relational world, you would have a single flat table where  you could easily scan and filter for orders containing a blue shirt in the last month, aggregate it, then you’re done.

## Verdict
Document/NoSQL models usually work well in transactional and app layers because it matches the **code we write**. Relation models tend to do better with analytical and business layers because it matches the **questions we ask**.
