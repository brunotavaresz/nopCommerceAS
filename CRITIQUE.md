# CRITIQUE — Reflexao Critica

## 1. O que correu bem

### Mexi no minimo possivel
So alterei dois ficheiros de codigo: o `OrderProcessingService.cs` (onde vive a logica do checkout) e o `Program.cs` (onde se configura o OTel SDK). A logica de negocio ficou exactamente como estava — apenas envolvi as chamadas existentes com `StartActivity()` e contadores. Controllers, data layer, plugins — tudo intacto. Se algo correr mal, reverter e trivial.

### Instrumentei no sitio certo
Podia ter metido spans no controller, mas o `CheckoutController` e basicamente um proxy — recebe o request e passa para o service. Toda a orquestracao real (cobrar, gravar a order, enviar emails, publicar eventos) acontece no `OrderProcessingService`. Instrumentar aqui mostra onde o tempo e realmente gasto, nao o overhead do HTTP.

### Sub-spans que servem para alguma coisa
Os 4 sub-spans (`process_payment`, `save_order`, `send_notifications`, `publish_event`) nao foram postos por "ficar bonito". Cada um isola uma fase concreta. Se amanha o checkout ficar lento, olho para o Jaeger e vejo logo: "ah, o `save_order` esta a demorar 3s, o resto e rapido". No load test com 5 utilizadores ao mesmo tempo, confirmei que a hierarquia se mantem — nao ha spans perdidos ou misturados.

### Atributos uteis sem dados pessoais
Nos spans so meti dados operacionais: `cart.item_count`, `order.total`, `payment.method`, `shipping.method`, etc. Zero nomes, zero emails, zero moradas. Foi uma decisao pensada desde o inicio, nao um fix depois.

### PII redaction no Collector como rede de seguranca
Mesmo sendo cuidadoso no codigo, a auto-instrumentacao do ASP.NET Core captura headers, cookies, e query strings automaticamente — e esses podem ter dados pessoais. O processor `attributes/pii-redact` no OTel Collector apaga tudo isso antes de chegar ao Jaeger. Verifiquei nos traces e confirmei: zero PII visivel.

### Load test que simula um utilizador real
O script k6 nao e um `curl` a bater num endpoint. Faz o fluxo completo: regista um utilizador novo, navega pelo catalogo, adiciona ao carrinho (com atributos do produto), submete o carrinho com gift wrapping e termos de servico, e depois faz os 6 passos AJAX do checkout. Gere CSRF tokens e sessoes. 55 checkouts completos, 605 checks, zero falhas.

### Docker Compose separado para observabilidade
Ter o `docker-compose.observability.yml` separado do `docker-compose.yml` principal e pratico. Posso correr a app sozinha sem a stack de observabilidade, ou ligar tudo junto. Facilita o desenvolvimento.

## 2. Obstaculos que encontrei

### Instalacao do nopCommerce rebentava com "Sequence contains more than one element"
Depois de rebuild com `--no-cache`, o nopCommerce voltou a pedir instalacao. A primeira tentativa de instalar pelo formulario web deu este erro. A solucao foi usar a opcao "Enter raw connection string" em vez de preencher os campos individuais, com: `Data Source=nopcommerce_database;Initial Catalog=nopcommerce;User Id=sa;Password=nopCommerce_db_password;Trust Server Certificate=True`. Funcionou a primeira.

### Docker build usava cache e nao apanhava mudancas no codigo
Depois de alterar o `OrderProcessingService.cs` e o `Program.cs`, fiz `docker compose build` mas o container continuava com o codigo antigo. O Docker estava a usar layers em cache. Resolvi com `docker compose build --no-cache nopcommerce_web`, que forca a recompilacao de tudo.

### Container nao reiniciava depois da instalacao
O nopCommerce, depois de instalar a BD, faz shutdown para reiniciar — mas o container Docker parava e nao voltava. Nao havia `restart: always` no compose. Resolvi com `docker restart nopcommerce` manual.

### k6 falhava no "order placed" — gift wrapping obrigatorio
O checkout retornava `{"error":1,"message":"Please select Gift wrapping;"}` e o k6 falhava no check final. O nopCommerce exige que o atributo de checkout "gift wrapping" seja definido antes de confirmar. A solucao foi adicionar um passo intermedio no k6 que submete o formulario do carrinho com `checkout_attribute_1=1` (No gift wrapping) e `termsofservice=on` antes de comecar o checkout.

### Atributo de gift wrapping no sitio errado
Primeiro tentei enviar `checkout_attribute_1` no passo de shipping, mas isso sobrescrevia o valor. O atributo tem de ser submetido no formulario do carrinho (`POST /cart`), nao nos passos AJAX do checkout. Depois de mover para o sitio certo, funcionou.

### Check do k6 nao reconhecia o formato da resposta
O check procurava `"redirect"` na resposta do `OpcConfirmOrder`, mas o nopCommerce devolvia `{"success":1}` (sem redirect). Corrigi o check para aceitar ambos: `confirm.body.includes('"success":1') || confirm.body.includes('"redirect"')`.

## 3. O que podia ser melhor

### Metricas sem labels
Os contadores `attempts` e `failures` sao globais — nao ha forma de filtrar por `payment_method` ou `country` no Prometheus. Se quiser saber "qual o error rate para Check/Money Order vs cartao?", nao consigo so com metricas. Tenho essa info nos spans (Jaeger), mas nao no Grafana. Adicionaria pelo menos `payment_method` como label.

### Histograma com buckets que nao servem
O histograma de duracao usa buckets default do OTel SDK. O checkout demora 4-5 segundos, e os buckets incluem 5ms, 10ms, 25ms que sao inuteis aqui. Buckets custom (500ms, 1s, 2s, 5s, 10s) dariam percentis mais precisos.

### Sem alertas no Grafana
O dashboard mostra graficos, mas ninguem vai estar a olhar 24/7. Em producao, um alerta tipo "error rate > 5% nos ultimos 5 minutos" seria essencial. Nao implementei, ficou so visual.

### Error Rate mostra "No data" em vez de 0%
Quando nao ha falhas, o contador `failures` simplesmente nao existe no Prometheus (nunca foi incrementado). A query PromQL devolve vazio. A fix e simples (`or vector(0)`), mas nao cheguei a aplicar.

### PII so e filtrada depois de sair da app
A redaccao acontece no Collector. Entre a app e o Collector, os dados vao em claro via gRPC. No meu setup Docker (mesma rede) nao e problema, mas em producao com Collector remoto precisaria de TLS ou de filtrar tambem dentro da app.

### So instrumentei um fluxo
Apenas o checkout tem spans e metricas custom. Pesquisa, inventario, devoluções, login — nada disso esta coberto. Foi intencional pelo scope do trabalho, mas num sistema real nao chegaria.

## 4. Trade-offs

| Decisao | Alternativa | Porque escolhi assim |
|---------|-------------|----------------------|
| Instrumentar no Service, nao no Controller | Spans no middleware/controller | A logica vive no service, o controller so faz proxy |
| PII redaction no Collector | Filtrar na app com `ActivityProcessor` | Centralizado, defence-in-depth, nao requer mudar codigo para novos atributos |
| Metricas sem labels | Labels por `payment_method` | Evitar cardinalidade alta; para este scope chega |
| Sub-spans manuais nos metodos privados | So o span pai `checkout.place_order` | Sem sub-spans nao consigo ver que fase e lenta |
| k6 com registo novo por VU/iteracao | Pool de utilizadores pre-criados | Isolamento total entre VUs; mais realista |
| Sem instrumentacao de SQL | Adicionar `SqlClient` tracing | Nao queria encher os traces de ruido com queries |
| `ActivitySource`/`Meter` como `static readonly` | Injectar via DI | Padrao recomendado pelo OTel .NET; menos overhead |

## 5. Com mais tempo faria...

1. **Instrumentacao de SQL** — ver queries dentro dos sub-spans, apanhar N+1 e queries lentas
2. **Sampling** — em producao nao posso exportar 100% dos traces; usaria tail-based sampling (sempre exportar traces com erro, amostrar o resto)
3. **Logs correlacionados** — ligar os logs (`ILogger`) ao TraceId para saltar de um log para o trace no Jaeger
4. **Metricas RED em todos os endpoints** — Rate, Errors, Duration nao so no checkout mas em toda a API
5. **Trace exemplars** — clicar num ponto do grafico no Grafana e abrir o trace correspondente no Jaeger
6. **Alertas** — pelo menos error rate e latencia p95 com notificacao
