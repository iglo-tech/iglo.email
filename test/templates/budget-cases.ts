// Finite council reproductions, shared by source, isolated compiled and production HTTP tests.
const longRange = `(${" ".repeat(8192)}1..600)`;
export const loopValueOfBody = `{% for i in ${longRange} %}{% assign x = forloop.valueOf %}{% endfor %}{{ x | raw }}`;
export const loopTruthinessBody = `{% for i in ${longRange} %}{% if forloop %}{% assign x = 1 %}{% endif %}{% endfor %}`;
export const literalArgumentBody = `{% for i in (1..20) %}{{ 'x' | upcase: ${Array(1100).fill("1").join(",")} }}{% endfor %}`;
export const validArgumentWorkBody =
  "{% for i in (1..700) %}{{ 'x' | t: 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h' | raw }}{% endfor %}";
const hashArguments = Array.from({ length: 1100 }, (_, i) => `a${i}:1`).join(" ");
const hashFlags = Array.from({ length: 1100 }, (_, i) => `a${i}`).join(" ");
export const loopHashArgumentBody = `{% for outer in (1..20) %}{% for inner in (1..1) ${hashArguments} %}x{% endfor %}{% endfor %}`;
export const loopHashFlagBody = `{% for outer in (1..20) %}{% for inner in (1..1) ${hashFlags} %}x{% endfor %}{% endfor %}`;
export const validLoopArgumentWorkBody =
  "{% for outer in (1..800) %}{% for inner in (1..1) offset:0 limit:1 reversed %}x{% endfor %}{% endfor %}";
export const budgetBypassBodies = [
  loopValueOfBody,
  loopTruthinessBody,
  literalArgumentBody,
  validArgumentWorkBody,
  loopHashArgumentBody,
  loopHashFlagBody,
  validLoopArgumentWorkBody,
  ...["offset", "limit", "reversed"].map(
    (name) => `{% assign values = (1..4) %}{% for i in (1..1) ${name}:values %}x{% endfor %}`,
  ),
];
export const modifierCoercionCase = {
  body: "{% for outer in (1..40) %}{% for inner in (1..1) offset:values %}x{% endfor %}{% endfor %}",
  data: { values: Array(900).fill("1".repeat(200)) },
};
export const loopModifierControls = [
  {
    body: "{% for i in (1..4) offset:continue limit:2 %}{{ i }}{% endfor %}",
    output: "12",
  },
  {
    body: "{% for i in (1..4) offset:'1' limit:'2' reversed %}{{ i }}{% endfor %}",
    output: "32",
  },
  {
    body: "{% for outer in (1..2) %}{% for inner in (1..4) offset:1 limit:2 reversed %}{{ inner }}{% endfor %}{% endfor %}",
    output: "3232",
  },
  {
    body: "{% for i in (1..4) limit:2 %}{{ i }}{% endfor %}/{% for i in (1..4) offset:continue limit:2 reversed %}{{ i }}{% endfor %}",
    output: "12/43",
  },
  {
    body: "{% for i in (1..4) offset limit reversed %}{{ i }}{% endfor %}",
    output: "2",
  },
  {
    body: "{% for i in (1..4) limit:1 limit:2 reversed:false %}{{ i }}{% endfor %}",
    output: "21",
  },
];
export const loopMetadataBody =
  "{% for i in (1..2) %}{{ forloop.index }}/{{ forloop.index0 }}/{{ forloop.rindex }}/{{ forloop.rindex0 }}/{{ forloop.first }}/{{ forloop.last }}/{{ forloop.length }};{% endfor %}";
export const loopMetadataOutput = "1/0/2/1/true/false/2;2/1/1/0/false/true/2;";
