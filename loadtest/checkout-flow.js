import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// k6 Load Test — Checkout Flow (Place Order)
//
// Drives the "Customer places an order" flow end-to-end:
//   1. Register a unique user
//   2. Browse product catalogue
//   3. Add product to cart
//   4. Complete one-page checkout (billing, shipping, payment, confirm)
//
// Usage:
//   k6 run loadtest/checkout-flow.js
//   k6 run --vus 5 --duration 2m loadtest/checkout-flow.js
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

// Custom k6 metrics
const checkoutSuccess = new Rate("checkout_success");
const checkoutDuration = new Trend("checkout_duration_ms");

export const options = {
  stages: [
    { duration: "30s", target: 3 },  // ramp up to 3 users
    { duration: "1m", target: 5 },   // hold at 5 users
    { duration: "30s", target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<5000"],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractToken(html) {
  const match = html.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/
  );
  return match ? match[1] : "";
}

// ── Main scenario ────────────────────────────────────────────────────────────

export default function () {
  const uniqueId = `${__VU}_${__ITER}_${Date.now()}`;
  const email = `loadtest_${uniqueId}@test.com`;
  const password = "LoadTest123!";

  // 1. Register a new user ──────────────────────────────────────────────────
  group("01 - Register", function () {
    const regPage = http.get(`${BASE_URL}/register`);
    const token = extractToken(regPage.body);

    const res = http.post(
      `${BASE_URL}/register`,
      {
        Gender: "M",
        FirstName: "Load",
        LastName: "Test",
        Email: email,
        Company: "",
        Password: password,
        ConfirmPassword: password,
        __RequestVerificationToken: token,
      },
      { redirects: 5 }
    );

    check(res, {
      "register ok": (r) =>
        r.status === 200 && r.url.includes("registerresult"),
    });
  });

  sleep(1);

  // 2. Browse product catalogue ─────────────────────────────────────────────
  group("02 - Browse products", function () {
    const home = http.get(`${BASE_URL}/`);
    check(home, { "home ok": (r) => r.status === 200 });

    const product = http.get(`${BASE_URL}/build-your-own-computer`);
    check(product, { "product page ok": (r) => r.status === 200 });
  });

  sleep(1);

  // 3. Add product to cart ──────────────────────────────────────────────────
  group("03 - Add to cart", function () {
    const productPage = http.get(`${BASE_URL}/build-your-own-computer`);
    const token = extractToken(productPage.body);

    const res = http.post(
      `${BASE_URL}/addproducttocart/details/1/1`,
      {
        "addtocart_1.EnteredQuantity": "1",
        __RequestVerificationToken: token,
        // Default attributes for "Build your own computer"
        "product_attribute_1": "1",   // Processor
        "product_attribute_2": "5",   // RAM
        "product_attribute_3": "7",   // HDD
        "product_attribute_4": "9",   // OS
        "product_attribute_5_11": "on", // Software
      },
      {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );

    check(res, {
      "add to cart ok": (r) => r.status === 200,
    });
  });

  sleep(1);

  // 4. Submit cart with checkout attributes ────────────────────────────────
  group("04 - Submit cart", function () {
    const cartPage = http.get(`${BASE_URL}/cart`);
    const cartToken = extractToken(cartPage.body);

    // Submit cart form: set gift wrapping to "No" and accept terms
    const cartSubmit = http.post(
      `${BASE_URL}/cart`,
      {
        checkout_attribute_1: "1",
        termsofservice: "on",
        checkout: "checkout",
        __RequestVerificationToken: cartToken,
      },
      { redirects: 5 }
    );

    check(cartSubmit, {
      "cart submitted": (r) => r.status === 200,
    });
  });

  sleep(0.5);

  // 5. Checkout flow ────────────────────────────────────────────────────────
  group("05 - Checkout", function () {
    const checkoutStart = Date.now();

    // Load checkout page
    const checkoutPage = http.get(`${BASE_URL}/onepagecheckout`, {
      redirects: 5,
    });

    if (checkoutPage.status !== 200) {
      checkoutSuccess.add(false);
      return;
    }

    const token = extractToken(checkoutPage.body);
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    };

    // Step 1: Save billing address
    const billing = http.post(
      `${BASE_URL}/checkout/OpcSaveBilling/`,
      {
        "BillingNewAddress.FirstName": "Load",
        "BillingNewAddress.LastName": "Test",
        "BillingNewAddress.Email": email,
        "BillingNewAddress.CountryId": "1",     // USA
        "BillingNewAddress.StateProvinceId": "0",
        "BillingNewAddress.City": "New York",
        "BillingNewAddress.Address1": "123 Test Street",
        "BillingNewAddress.ZipPostalCode": "10001",
        "BillingNewAddress.PhoneNumber": "1234567890",
        __RequestVerificationToken: token,
      },
      { headers }
    );
    check(billing, { "billing ok": (r) => r.status === 200 });

    sleep(0.5);

    // Step 2: Save shipping address (same as billing)
    const shippingAddr = http.post(
      `${BASE_URL}/checkout/OpcSaveShipping/`,
      {
        "ShippingNewAddress.FirstName": "Load",
        "ShippingNewAddress.LastName": "Test",
        "ShippingNewAddress.Email": email,
        "ShippingNewAddress.CountryId": "1",
        "ShippingNewAddress.StateProvinceId": "0",
        "ShippingNewAddress.City": "New York",
        "ShippingNewAddress.Address1": "123 Test Street",
        "ShippingNewAddress.ZipPostalCode": "10001",
        "ShippingNewAddress.PhoneNumber": "1234567890",
        __RequestVerificationToken: token,
      },
      { headers }
    );
    check(shippingAddr, { "shipping addr ok": (r) => r.status === 200 });

    sleep(0.5);

    // Step 3: Save shipping method
    const shipping = http.post(
      `${BASE_URL}/checkout/OpcSaveShippingMethod/`,
      {
        shippingoption: "Ground___Shipping.FixedByWeightByTotal",
        __RequestVerificationToken: token,
      },
      { headers }
    );
    check(shipping, { "shipping ok": (r) => r.status === 200 });

    sleep(0.5);

    // Step 3: Save payment method
    const payment = http.post(
      `${BASE_URL}/checkout/OpcSavePaymentMethod/`,
      {
        paymentmethod: "Payments.CheckMoneyOrder",
        __RequestVerificationToken: token,
      },
      { headers }
    );
    check(payment, { "payment ok": (r) => r.status === 200 });

    sleep(0.5);

    // Step 4: Save payment info
    const paymentInfo = http.post(
      `${BASE_URL}/checkout/OpcSavePaymentInfo/`,
      {
        __RequestVerificationToken: token,
      },
      { headers }
    );
    check(paymentInfo, { "payment info ok": (r) => r.status === 200 });

    sleep(0.5);

    // Step 5: Confirm order — THIS triggers checkout.place_order span
    const confirm = http.post(
      `${BASE_URL}/checkout/OpcConfirmOrder/`,
      {
        __RequestVerificationToken: token,
      },
      { headers }
    );

    const success =
      confirm.status === 200 &&
      confirm.body &&
      (confirm.body.includes('"success":1') || confirm.body.includes('"redirect"'));

    check(confirm, {
      "order placed": () => success,
    });

    checkoutSuccess.add(success);
    checkoutDuration.add(Date.now() - checkoutStart);
  });

  sleep(2);
}
