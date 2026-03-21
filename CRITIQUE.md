# CRITIQUE

## O que no design do nopCommerce ajudou ou dificultou a instrumentacao?

### O que ajudou

A arquitectura em camadas com separacao clara (Core, Data, Services, Web.Framework, Web) facilitou a decisao de onde instrumentar. A logica de negocio do checkout esta concentrada num unico metodo — `OrderProcessingService.PlaceOrderAsync` — o que significa que um unico ponto de instrumentacao captura todo o fluxo. Nao tive de andar a espalhar spans por dezenas de ficheiros.

O facto de o nopCommerce usar injecao de dependencias em todo o lado e os servicos terem metodos async bem definidos tambem ajudou. Adicionar `ActivitySource.StartActivity()` no inicio de um metodo async encaixa naturalmente no padrao existente.

O `IEventPublisher` e outro ponto positivo — e um mecanismo pub/sub in-process por onde todos os eventos passam (incluindo o `OrderPlacedEvent`). E um ponto natural de instrumentacao porque e um gargalo unico: instrumentar ali cobre todos os eventos sem tocar nos consumers individuais.

A configuracao via `Program.cs` como ponto de entrada unico da aplicacao tambem simplificou — adicionei o SDK do OpenTelemetry (tracing + metrics + OTLP exporter) num unico bloco de codigo, sem precisar de mexer em startup classes dispersas.

### O que dificultou

Os sub-passos do checkout — `GetProcessPaymentResultAsync`, `SaveOrderDetailsAsync`, `MoveShoppingCartItemsToOrderItemsAsync`, `SendNotificationsAndSaveNotesAsync` — sao metodos **protected virtual** dentro do `OrderProcessingService`. Apesar de poderem ser overridden numa subclasse, na pratica ninguem os chama de fora — sao passos internos do `PlaceOrderAsync`. Para os instrumentar sem modificar a classe directamente, teria de criar uma subclasse que faz override de cada metodo so para adicionar spans, o que e fragil e pouco pratico. Se fossem servicos separados injectados via DI, poderia usar decorators ou middleware para adicionar spans sem tocar no codigo de negocio.

O `PlaceOrderAsync` usa uma local function (`placeOrder`) com logica condicional para locking (`PlaceOrderWithLock`). Isto complicou o posicionamento dos sub-spans porque tive de os colocar dentro da local function, respeitando os dois caminhos de execucao (com e sem lock).

O sistema de caching (`IStaticCacheManager`) e usado de forma transparente em toda a stack. Nao ha forma facil de saber, a partir de um trace, se um resultado veio do cache ou da base de dados. Para ter essa visibilidade, teria de instrumentar o cache manager — o que afectaria toda a aplicacao, nao so o checkout.

Os plugins (Brevo, Avalara, etc.) sao event consumers independentes registados automaticamente via DI scan. Cada plugin e uma "caixa preta" — instrumenta-los requer modificar cada um individualmente, o que nao e pratico.

## O que mudaria para tornar o nopCommerce mais observavel — e a que custo?

**Extrair os sub-passos do checkout para servicos injectaveis.** Em vez de metodos privados dentro do `OrderProcessingService`, teria `IPaymentProcessingService`, `IOrderPersistenceService`, `IOrderNotificationService`. Isto permitiria instrumentar cada fase com decorators ou middleware, sem tocar na logica de negocio. O custo e refactoring significativo — o `OrderProcessingService` tem ~1800 linhas e os metodos privados partilham estado local entre si. Separar isto sem introduzir bugs requer testes de regressao que o projecto actualmente nao tem cobertura suficiente para garantir.

**Adicionar um `IObservableEventPublisher` wrapper.** O `EventPublisher` actual nao emite spans. Um wrapper que cria um span por evento publicado (com o tipo de evento como atributo) daria visibilidade sobre todos os eventos do sistema automaticamente. O custo e minimo — uma classe wrapper e uma alteracao no registo de DI.

**Tornar o cache manager observavel.** Adicionar metricas de hit/miss rate ao `IStaticCacheManager` permitiria saber se o sistema esta a servir dados do cache ou a ir a BD. O custo e uma alteracao no cache manager ou um decorator, mas afecta performance porque adicionaria overhead a cada operacao de cache (que sao milhares por request).

**Adicionar interfaces de telemetria no Core.** Criar uma abstraccao tipo `ITelemetryProvider` no `Nop.Core` evitaria a dependencia directa do `System.Diagnostics` na camada de Services. Mas isto e over-engineering para o scope actual — o `ActivitySource` do .NET ja e a abstraccao standard e nao cria acoplamento problematico.

## Onde fiz mudancas cirurgicas e como minimizei o impacto?

### Mudanca 1: `OrderProcessingService.cs` (Nop.Services)

Esta foi a mudanca principal. Adicionei:
- Campos `static readonly` para `ActivitySource`, `Meter`, 2 contadores e 1 histograma (linhas 47-54)
- Span pai `checkout.place_order` a envolver o `PlaceOrderAsync` com atributos operacionais (zero PII)
- 4 sub-spans dentro da local function `placeOrder`: `checkout.process_payment`, `checkout.save_order`, `checkout.send_notifications`, `checkout.publish_event`
- Metodo helper `RecordPlaceOrderTelemetry` para registar metricas e status do span

A logica de negocio nao foi alterada — os spans envolvem (`using var activity = ...`) as chamadas existentes sem mudar o fluxo de execucao. Se o OpenTelemetry SDK nao estiver configurado, o `StartActivity` retorna `null` e o overhead e zero.

Escolhi `static readonly` para o `ActivitySource` e `Meter` porque e o padrao recomendado pelo OpenTelemetry .NET — evita criar instancias por request e o lifecycle e gerido pelo SDK.

### Mudanca 2: `Program.cs` (Nop.Web)

Adicionei a configuracao do OpenTelemetry SDK: `AddOpenTelemetry()` com tracing (ASP.NET Core + HttpClient auto-instrumentacao + o meu `ActivitySource`), metrics (ASP.NET Core + HttpClient + Runtime + o meu `Meter`), e OTLP exporter apontado para o Collector. Sao ~15 linhas no ponto de entrada da aplicacao. Nenhuma outra classe foi afectada.

### Mudanca 3: `NopTelemetryConstants.cs` (nova)

Criei uma classe com duas constantes (`ActivitySourceName` e `MeterName`) para evitar magic strings espalhadas entre o `OrderProcessingService` e o `Program.cs`. Ficheiro novo, sem impacto no codigo existente.

### O que nao toquei

- **Controllers** — a auto-instrumentacao do ASP.NET Core ja cria spans para cada request HTTP. Nao precisei de tocar no `CheckoutController`.
- **Data layer** — nao adicionei instrumentacao de SQL. Teria adicionado ruido aos traces sem beneficio claro para o fluxo do checkout.
- **Plugins** — cada plugin e independente e instrumenta-los estaria fora do scope.
- **EventPublisher** — apesar de ser um bom ponto de instrumentacao, instrumentei directamente a chamada `PublishAsync(OrderPlacedEvent)` dentro do `OrderProcessingService` em vez de modificar o publisher generico. Mudanca mais localizada.
