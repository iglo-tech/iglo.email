// Finite council reproductions, shared by source, isolated compiled and production HTTP tests.
const longRange = `(${" ".repeat(8192)}1..600)`;
export const loopValueOfBody = `{% for i in ${longRange} %}{% assign x = forloop.valueOf %}{% endfor %}{{ x | raw }}`;
export const loopTruthinessBody = `{% for i in ${longRange} %}{% if forloop %}{% assign x = 1 %}{% endif %}{% endfor %}`;
export const literalArgumentBody = `{% for i in (1..20) %}{{ 'x' | upcase: ${Array(1100).fill("1").join(",")} }}{% endfor %}`;
export const validArgumentWorkBody =
  "{% for i in (1..700) %}{{ 'x' | t: 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h' | raw }}{% endfor %}";
export const budgetBypassBodies = [
  loopValueOfBody,
  loopTruthinessBody,
  literalArgumentBody,
  validArgumentWorkBody,
];
export const loopMetadataBody =
  "{% for i in (1..2) %}{{ forloop.index }}/{{ forloop.index0 }}/{{ forloop.rindex }}/{{ forloop.rindex0 }}/{{ forloop.first }}/{{ forloop.last }}/{{ forloop.length }};{% endfor %}";
export const loopMetadataOutput = "1/0/2/1/true/false/2;2/1/1/0/false/true/2;";
