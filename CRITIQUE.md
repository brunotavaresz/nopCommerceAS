# CRITIQUE

## What in nopCommerce's design helped or hindered instrumentation?

### What helped

The layered architecture made it clear where to instrument. Checkout logic lives in one method — `OrderProcessingService.PlaceOrderAsync` — so a single instrumentation point covers the whole flow. I didn't have to touch dozens of files.

DI everywhere and async methods helped too. Wrapping an async call with `ActivitySource.StartActivity()` fits the existing code style without friction.

`IEventPublisher` was a nice surprise — it's an in-process pub/sub where all events go through, including `OrderPlacedEvent`. One instrumentation point there could cover all events without modifying individual consumers.

Having `Program.cs` as the single entry point also made things easier. I wired up the entire OTel SDK (tracing + metrics + OTLP exporter) in one place, no scattered startup classes to hunt down.

### What hindered

The checkout sub-steps — `GetProcessPaymentResultAsync`, `SaveOrderDetailsAsync`, `architecture-flowMoveShoppingCartItemsToOrderItemsAsync`, `SendNotificationsAndSaveNotesAsync` — are all **protected virtual** methods inside `OrderProcessingService`. They can technically be overridden via subclass, but nobody calls them from outside — they're internal steps of `PlaceOrderAsync`. Creating a subclass just to wrap each method with a span felt fragile and disproportionate. If they were separate services behind DI interfaces, I could have used decorators instead of touching the class directly.

Another thing that complicated the work: `PlaceOrderAsync` internally uses a local function (`placeOrder`) with conditional locking logic (`PlaceOrderWithLock`). I had to place my sub-spans inside that local function, respecting both execution paths (with and without lock). Not obvious at first.

The caching layer (`IStaticCacheManager`) is completely transparent — there's no way to tell from a trace if data came from cache or from the DB. Instrumenting the cache manager would give that visibility, but it would affect the entire application, not just checkout. I decided it wasn't worth it.

Plugins (Brevo, Avalara, etc.) are black boxes — independent event consumers auto-registered via DI scan. Each would need individual modification, not practical for this scope.

## What would I change to make nopCommerce more observable — and at what cost?

The biggest improvement would be **extracting the checkout sub-steps into injectable services**. Instead of `protected virtual` methods buried inside a ~1800-line class, have `IPaymentProcessingService`, `IOrderPersistenceService`, `IOrderNotificationService`. Then I could instrument each phase with decorators, no need to touch business logic. But this is heavy refactoring — the class is ~3600 lines, the internal methods share local state, and the project doesn't have enough test coverage to do it safely.

A simpler win: **wrapping `EventPublisher`** with an observable version that creates a span per published event. One wrapper class, one DI registration change, and suddenly every event in the system is visible. I didn't do this because I wanted to keep changes minimal, but it's the first thing I'd add next.

**Making the cache manager observable** (hit/miss rate metrics on `IStaticCacheManager`) would also help, though the overhead on thousands of cache ops per request is a real concern.

I also considered **adding a telemetry abstraction in Nop.Core** (`ITelemetryProvider` or similar) to avoid `System.Diagnostics` references in the Services layer. But honestly, `ActivitySource` is already the .NET standard — adding another abstraction on top would be over-engineering.

## Where did I make surgical changes and how did I minimise impact?

### OrderProcessingService.cs (Nop.Services)

This was the main change. I added `static readonly` fields for `ActivitySource`, `Meter`, 2 counters and 1 histogram at the top of the class. Then wrapped `PlaceOrderAsync` with a parent span (`checkout.place_order`) and added 4 sub-spans inside the local function: `checkout.process_payment`, `checkout.save_order`, `checkout.send_notifications`, `checkout.publish_event`. Also added a helper `RecordPlaceOrderTelemetry` for metrics recording.

The key thing: business logic was not altered. Spans use `using var activity = ...` around existing calls — if the OTel SDK isn't configured, `StartActivity` returns `null` and the overhead is zero. I used `static readonly` for `ActivitySource` and `Meter` because that's the recommended OTel .NET pattern (avoids per-request allocation, lifecycle managed by the SDK).

### Program.cs (Nop.Web)

Added ~15 lines of OTel SDK config: `AddOpenTelemetry()` with ASP.NET Core + HttpClient + SqlClient auto-instrumentation, my custom `ActivitySource` and `Meter`, and an OTLP exporter pointing at the Collector. Nothing else in the project was affected.

### NopTelemetryConstants.cs (new file)

A small constants file with `ActivitySourceName` and `MeterName` — shared between `OrderProcessingService` and `Program.cs` so the names match. Without this, a typo in either file would silently break span collection and you'd spend hours debugging why traces don't show up.

### What I did NOT touch

- **Controllers** — auto-instrumentation already covers HTTP spans, no point adding more.
- **Data layer** — SqlClient auto-instrumentation captures SQL queries as child spans under `checkout.save_order`. Adding custom SQL instrumentation on top would just be noise.
- **Plugins** — out of scope, each is independent.
- **EventPublisher** — instead of modifying the generic publisher (which would affect the whole system), I instrumented the specific `PublishAsync(OrderPlacedEvent)` call inside `OrderProcessingService`. More targeted.
