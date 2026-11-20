// Reference renderer for the Markdown measurement helper (test/templates/measure-markdown.ts, B106).
// goldmark v1.8.6 with listmonk's options at 6fcd95f (models/common.go): WithAutoHeadingID, WithXHTML,
// WithUnsafe, Table, Strikethrough, TaskList and the Typographer with curly double quotes replaced by ".
//
//	go run . listmonk <corpus.json> <out.json>   listmonk's configuration
//	go run . spec <spec.json> <out.json>         plain goldmark (CommonMark, no extensions)
//
// Not part of the Bun build and not run by any test: a manual reference for the helper's compare mode.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
)

type doc struct {
	ID  string `json:"id"`
	Src string `json:"src"`
}

type result struct {
	ID   string `json:"id"`
	HTML string `json:"html"`
}

func listmonk() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		goldmark.WithRendererOptions(html.WithXHTML(), html.WithUnsafe()),
		goldmark.WithExtensions(
			extension.Table,
			extension.Strikethrough,
			extension.TaskList,
			extension.NewTypographer(
				extension.WithTypographicSubstitutions(extension.TypographicSubstitutions{
					extension.LeftDoubleQuote:  []byte(`"`),
					extension.RightDoubleQuote: []byte(`"`),
				}),
			),
		),
	)
}

func plain() goldmark.Markdown {
	return goldmark.New(goldmark.WithRendererOptions(html.WithUnsafe()))
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: listmonk|spec <in.json> <out.json>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	var docs []doc
	if err := json.Unmarshal(raw, &docs); err != nil {
		panic(err)
	}
	md := listmonk()
	if os.Args[1] == "spec" {
		md = plain()
	}
	results := make([]result, 0, len(docs))
	for _, d := range docs {
		var buf bytes.Buffer
		if err := md.Convert([]byte(d.Src), &buf); err != nil {
			results = append(results, result{ID: d.ID, HTML: "ERROR " + err.Error()})
			continue
		}
		results = append(results, result{ID: d.ID, HTML: buf.String()})
	}
	out, err := json.Marshal(results)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(os.Args[3], out, 0o644); err != nil {
		panic(err)
	}
}
