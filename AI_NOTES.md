# AI Usage Notes

## Tools used

I used ChatGPT to help structure the implementation, draft parts of the Express/PostgreSQL transaction logic, scaffold the React UI and hooks, and develop the test/documentation plan. The resulting code should still be reviewed and run locally; AI-assisted output is not evidence that the app has passed tests on a particular machine.

## Prompt that worked well

> Review this self-service checkout design as a PostgreSQL concurrency problem. Treat physical stock and active reservations separately, identify every transaction that can change the reservation count, and propose a lock order that prevents overselling and double pickup. Include the late-payment path and the exact integration tests needed to prove it.

This was useful because it focused the work on the inventory invariants and transactional boundaries instead of starting with UI styling.

## A specific mistake caught during development

An early version of the catalog availability query only subtracted `pending_payment` reservations. Thinking through the case where an order had been paid but was waiting in a locker exposed the flaw: those units would appear available to another customer even though the first customer could still claim them. The query and README were changed to keep `paid` orders allocated until pickup; pickup then decrements physical stock and changes the order to `claimed` inside the same transaction. The integration test checks that stock only decreases once during simultaneous claims.

A second review point was to avoid using the kiosk's wall clock to judge hold expiry. The payment path now checks expiry using PostgreSQL time, and the customer timer is based on a server-provided duration plus `performance.now()`.

## Verification status

Run `npm run build`, `npm run test:integration`, and (with k6 installed and a disposable database) `npm run k6:test` before submitting. Only describe those checks as passed after they have been run successfully in your local environment.
