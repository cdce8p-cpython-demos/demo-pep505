from dataclasses import dataclass

@dataclass
class Item:
    name: str
    price: float

@dataclass
class ShoppingCard:
    items: list[Item] | None = None

@dataclass
class Customer:
    name: str | None = None
    card: ShoppingCard | None = None
    discount: float | None = None

alex = Customer(
    name="Alex",
    card=ShoppingCard(
        items=[
            Item("Apples", 3.14),
            Item("Bananas", 2.72),
        ]))

sandra = Customer(card=ShoppingCard())

for customer in (alex, sandra):
    print(f"Customer: {customer.name?.upper()}")
    customer.name ??= "Unknown customer"
    print(f"Updated name: {customer.name}")

    total = sum(
        item.price for item in customer.card?.items ?? ()
    )
    print(f"Shopping card total: {total}")

    first_item = customer.card?.items?[0]
    print(f"First item in shopping card: {first_item}")

    second_item = maybe customer.card.items[1]
    print(f"Second item in shopping card: {second_item}")

    print("---")
