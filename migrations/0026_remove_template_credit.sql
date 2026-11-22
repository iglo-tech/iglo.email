-- B129 (D127): the built-in templates lose the product credit and take the brand. An earlier release
-- seeded these bodies into every install, and the template store seeds only an empty database, so an
-- install from before this release still holds them. Each UPDATE matches the template type and the
-- whole stored body byte for byte, so only a copy that still holds the seeded body changes. An edited,
-- renamed or cloned-and-edited template keeps its body. Names, subjects, default flags and campaign
-- references are not touched. The old bodies are the built-in files as they were on main, the new
-- ones are the files as they are now, and single quotes are doubled in the literals.

UPDATE templates
SET body = '{% comment %}Adapted from listmonk static/email-templates/default.tpl at 6fcd95f.{% endcomment %}
<!doctype html>
<html>
    <head>
        <title>{{ campaign.subject }}</title>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
        <base target="_blank">
        <style>
            body {
                background-color: #F0F1F3;
                font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;
                font-size: 15px;
                line-height: 26px;
                margin: 0;
                color: #444;
            }

            pre {
                background: #f4f4f4f4;
                padding: 2px;
            }

            table {
                width: 100%;
                border: 1px solid #ddd;
            }
            table td {
                border-color: #ddd;
                padding: 5px;
            }

            .wrap {
                background-color: #fff;
                padding: 30px;
                max-width: 525px;
                margin: 0 auto;
                border-radius: 5px;
            }

            .button {
                background: {{ brand_accent }};
                border-radius: 3px;
                text-decoration: none !important;
                color: {{ brand_on_accent }} !important;
                font-weight: bold;
                padding: 10px 30px;
                display: inline-block;
            }
            .button:hover {
                background: #111;
            }

            .footer {
                text-align: center;
                font-size: 12px;
                color: #888;
            }
                .footer a {
                    color: #888;
                    margin-right: 5px;
                }

            .gutter {
                padding: 30px;
            }

            img {
                max-width: 100%;
                height: auto;
            }

            a {
                color: {{ brand_accent }};
            }
                a:hover {
                    color: #111;
                }
            @media screen and (max-width: 600px) {
                .wrap {
                    max-width: auto;
                }
                .gutter {
                    padding: 10px;
                }
            }
        </style>
    </head>
<body style="background-color: #F0F1F3;font-family: {% if brand_font != "" %}{{ brand_font }}{% else %}''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif{% endif %};font-size: 15px;line-height: 26px;margin: 0;color: #444;">
    <div class="gutter" style="padding: 30px;">&nbsp;</div>
    <div class="wrap" style="background-color: #fff;padding: 30px;max-width: 525px;margin: 0 auto;border-radius: 5px;">
        {{ content | raw }}
    </div>

    <div class="footer" style="text-align: center;font-size: 12px;color: #888;">
        <p>
            <a href="{{ unsubscribe_url }}" style="color: #888;">{{ "globals.buttons.unsubscribe" | t }}</a>
            &nbsp;&nbsp;
            <a href="{{ message_url }}" style="color: #888;">{{ "email.viewInBrowser" | t }}</a>
        </p>
    </div>
    <div class="gutter" style="padding: 30px;">&nbsp;{{ track_view }}</div>
</body>
</html>
', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'campaign' AND body_source IS NULL AND body = '{% comment %}Adapted from listmonk static/email-templates/default.tpl at 6fcd95f.{% endcomment %}
<!doctype html>
<html>
    <head>
        <title>{{ campaign.subject }}</title>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
        <base target="_blank">
        <style>
            body {
                background-color: #F0F1F3;
                font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;
                font-size: 15px;
                line-height: 26px;
                margin: 0;
                color: #444;
            }

            pre {
                background: #f4f4f4f4;
                padding: 2px;
            }

            table {
                width: 100%;
                border: 1px solid #ddd;
            }
            table td {
                border-color: #ddd;
                padding: 5px;
            }

            .wrap {
                background-color: #fff;
                padding: 30px;
                max-width: 525px;
                margin: 0 auto;
                border-radius: 5px;
            }

            .button {
                background: #0055d4;
                border-radius: 3px;
                text-decoration: none !important;
                color: #fff !important;
                font-weight: bold;
                padding: 10px 30px;
                display: inline-block;
            }
            .button:hover {
                background: #111;
            }

            .footer {
                text-align: center;
                font-size: 12px;
                color: #888;
            }
                .footer a {
                    color: #888;
                    margin-right: 5px;
                }

            .gutter {
                padding: 30px;
            }

            img {
                max-width: 100%;
                height: auto;
            }

            a {
                color: #0055d4;
            }
                a:hover {
                    color: #111;
                }
            @media screen and (max-width: 600px) {
                .wrap {
                    max-width: auto;
                }
                .gutter {
                    padding: 10px;
                }
            }
        </style>
    </head>
<body style="background-color: #F0F1F3;font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;font-size: 15px;line-height: 26px;margin: 0;color: #444;">
    <div class="gutter" style="padding: 30px;">&nbsp;</div>
    <div class="wrap" style="background-color: #fff;padding: 30px;max-width: 525px;margin: 0 auto;border-radius: 5px;">
        {{ content | raw }}
    </div>

    <div class="footer" style="text-align: center;font-size: 12px;color: #888;">
        <p>
            <a href="{{ unsubscribe_url }}" style="color: #888;">{{ "globals.buttons.unsubscribe" | t }}</a>
            &nbsp;&nbsp;
            <a href="{{ message_url }}" style="color: #888;">{{ "email.viewInBrowser" | t }}</a>
        </p>
    </div>
    <div class="gutter" style="padding: 30px;">&nbsp;{{ track_view }}</div>
</body>
</html>
';

UPDATE templates
SET body = '{% comment %}Adapted from listmonk static/email-templates/default-archive.tpl at 6fcd95f.{% endcomment %}
<!doctype html>
<html>
    <head>
        <title>{{ campaign.subject }}</title>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
        <base target="_blank">
        <style>
            body {
                background-color: #F0F1F3;
                font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;
                font-size: 15px;
                line-height: 26px;
                margin: 0;
                color: #444;
            }

            pre {
                background: #f4f4f4f4;
                padding: 2px;
            }

            table {
                width: 100%;
                border: 1px solid #ddd;
            }
            table td {
                border-color: #ddd;
                padding: 5px;
            }

            .wrap {
                background-color: #fff;
                padding: 30px;
                max-width: 525px;
                margin: 0 auto;
                border-radius: 5px;
            }

            .button {
                background: {{ brand_accent }};
                border-radius: 3px;
                text-decoration: none !important;
                color: {{ brand_on_accent }} !important;
                font-weight: bold;
                padding: 10px 30px;
                display: inline-block;
            }
            .button:hover {
                background: #111;
            }

            .footer {
                text-align: center;
                font-size: 12px;
                color: #888;
            }
                .footer a {
                    color: #888;
                    margin-right: 5px;
                }

            .gutter {
                padding: 30px;
            }

            img {
                max-width: 100%;
                height: auto;
            }

            a {
                color: {{ brand_accent }};
            }
                a:hover {
                    color: #111;
                }
            @media screen and (max-width: 600px) {
                .wrap {
                    max-width: auto;
                }
                .gutter {
                    padding: 10px;
                }
            }
        </style>
    </head>
<body style="background-color: #F0F1F3;font-family: {% if brand_font != "" %}{{ brand_font }}{% else %}''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif{% endif %};font-size: 15px;line-height: 26px;margin: 0;color: #444;">
    <div class="gutter" style="padding: 30px;">&nbsp;</div>
    <div class="wrap" style="background-color: #fff;padding: 30px;max-width: 525px;margin: 0 auto;border-radius: 5px;">
        {% if brand_header == "logo" %}
            <p style="text-align: center; margin: 0 0 16px;"><img src="{{ logo_url }}" alt="{{ site_name }}" style="max-height: 48px; max-width: 100%;" /></p>
        {% elsif brand_header == "logo_and_name" %}
            <p style="text-align: center; margin: 0 0 16px;"><img src="{{ logo_url }}" alt="" style="max-height: 40px; max-width: 120px; vertical-align: middle; margin-right: 12px;" /><span style="font-size: 18px; font-weight: 600; color: #111; vertical-align: middle;">{{ site_name }}</span></p>
        {% else %}
            <p style="text-align: center; margin: 0 0 16px; font-size: 18px; font-weight: 600; color: #111;">{{ site_name }}</p>
        {% endif %}
        {{ content | raw }}
    </div>
</body>
</html>
', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'campaign' AND body_source IS NULL AND body = '{% comment %}Adapted from listmonk static/email-templates/default-archive.tpl at 6fcd95f.{% endcomment %}
<!doctype html>
<html>
    <head>
        <title>{{ campaign.subject }}</title>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
        <base target="_blank">
        <style>
            body {
                background-color: #F0F1F3;
                font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;
                font-size: 15px;
                line-height: 26px;
                margin: 0;
                color: #444;
            }

            pre {
                background: #f4f4f4f4;
                padding: 2px;
            }

            table {
                width: 100%;
                border: 1px solid #ddd;
            }
            table td {
                border-color: #ddd;
                padding: 5px;
            }

            .wrap {
                background-color: #fff;
                padding: 30px;
                max-width: 525px;
                margin: 0 auto;
                border-radius: 5px;
            }

            .button {
                background: #0055d4;
                border-radius: 3px;
                text-decoration: none !important;
                color: #fff !important;
                font-weight: bold;
                padding: 10px 30px;
                display: inline-block;
            }
            .button:hover {
                background: #111;
            }

            .footer {
                text-align: center;
                font-size: 12px;
                color: #888;
            }
                .footer a {
                    color: #888;
                    margin-right: 5px;
                }

            .gutter {
                padding: 30px;
            }

            img {
                max-width: 100%;
                height: auto;
            }

            a {
                color: #0055d4;
            }
                a:hover {
                    color: #111;
                }
            @media screen and (max-width: 600px) {
                .wrap {
                    max-width: auto;
                }
                .gutter {
                    padding: 10px;
                }
            }
        </style>
    </head>
<body style="background-color: #F0F1F3;font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;font-size: 15px;line-height: 26px;margin: 0;color: #444;">
    <div class="gutter" style="padding: 30px;">&nbsp;</div>
    <div class="wrap" style="background-color: #fff;padding: 30px;max-width: 525px;margin: 0 auto;border-radius: 5px;">
        {{ content | raw }}
    </div>

    <div class="footer" style="text-align: center;font-size: 12px;color: #888;">
        <p>{{ "public.poweredBy" | t }} <a href="https://listmonk.app" target="_blank" rel="noreferrer" style="color: #888;">listmonk</a></p>
    </div>
</body>
</html>
';

UPDATE templates
SET body = '{% comment %}Adapted from listmonk static/email-templates/sample-tx.tpl at 6fcd95f.{% endcomment %}
<!doctype html>
<html>
    <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
        <base target="_blank">

        <style>
            body {
                background-color: #F0F1F3;
                font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;
                font-size: 15px;
                line-height: 26px;
                margin: 0;
                color: #444;
            }

            pre {
                background: #f4f4f4f4;
                padding: 2px;
            }

            table {
                width: 100%;
                border: 1px solid #ddd;
            }
            table td {
                border-color: #ddd;
                padding: 5px;
            }

            .wrap {
                background-color: #fff;
                padding: 30px;
                max-width: 525px;
                margin: 0 auto;
                border-radius: 5px;
            }

            .button {
                background: #0055d4;
                border-radius: 3px;
                text-decoration: none !important;
                color: #fff !important;
                font-weight: bold;
                padding: 10px 30px;
                display: inline-block;
            }
            .button:hover {
                background: #111;
            }

            .footer {
                text-align: center;
                font-size: 12px;
                color: #888;
            }
                .footer a {
                    color: #888;
                    margin-right: 5px;
                }

            .gutter {
                padding: 30px;
            }

            img {
                max-width: 100%;
                height: auto;
            }

            a {
                color: #0055d4;
            }
                a:hover {
                    color: #111;
                }
            @media screen and (max-width: 600px) {
                .wrap {
                    max-width: auto;
                }
                .gutter {
                    padding: 10px;
                }
            }
        </style>
    </head>
<body style="background-color: #F0F1F3;font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;font-size: 15px;line-height: 26px;margin: 0;color: #444;">
    <div class="gutter" style="padding: 30px;">&nbsp;</div>
    <div class="wrap" style="background-color: #fff;padding: 30px;max-width: 525px;margin: 0 auto;border-radius: 5px;">
        <p>Hello {{ subscriber.name }}</p>
        <p>
            <strong>Order number: </strong> {{ data.order_id }}<br />
            <strong>Shipping date: </strong> {{ data.shipping_date }}<br />
        </p>
        <br />
        <p>
            Transactional templates supports arbitrary parameters.
            Render them using <code>data.your_param_name</code>.
        </p>
    </div>
</body>
</html>
'
WHERE type = 'tx' AND body = '{% comment %}Adapted from listmonk static/email-templates/sample-tx.tpl at 6fcd95f.{% endcomment %}
<!doctype html>
<html>
    <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
        <base target="_blank">

        <style>
            body {
                background-color: #F0F1F3;
                font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;
                font-size: 15px;
                line-height: 26px;
                margin: 0;
                color: #444;
            }

            pre {
                background: #f4f4f4f4;
                padding: 2px;
            }

            table {
                width: 100%;
                border: 1px solid #ddd;
            }
            table td {
                border-color: #ddd;
                padding: 5px;
            }

            .wrap {
                background-color: #fff;
                padding: 30px;
                max-width: 525px;
                margin: 0 auto;
                border-radius: 5px;
            }

            .button {
                background: #0055d4;
                border-radius: 3px;
                text-decoration: none !important;
                color: #fff !important;
                font-weight: bold;
                padding: 10px 30px;
                display: inline-block;
            }
            .button:hover {
                background: #111;
            }

            .footer {
                text-align: center;
                font-size: 12px;
                color: #888;
            }
                .footer a {
                    color: #888;
                    margin-right: 5px;
                }

            .gutter {
                padding: 30px;
            }

            img {
                max-width: 100%;
                height: auto;
            }

            a {
                color: #0055d4;
            }
                a:hover {
                    color: #111;
                }
            @media screen and (max-width: 600px) {
                .wrap {
                    max-width: auto;
                }
                .gutter {
                    padding: 10px;
                }
            }
        </style>
    </head>
<body style="background-color: #F0F1F3;font-family: ''Helvetica Neue'', ''Segoe UI'', Helvetica, sans-serif;font-size: 15px;line-height: 26px;margin: 0;color: #444;">
    <div class="gutter" style="padding: 30px;">&nbsp;</div>
    <div class="wrap" style="background-color: #fff;padding: 30px;max-width: 525px;margin: 0 auto;border-radius: 5px;">
        <p>Hello {{ subscriber.name }}</p>
        <p>
            <strong>Order number: </strong> {{ data.order_id }}<br />
            <strong>Shipping date: </strong> {{ data.shipping_date }}<br />
        </p>
        <br />
        <p>
            Transactional templates supports arbitrary parameters.
            Render them using <code>data.your_param_name</code>. For more information,
            see the transactional mailing <a href="https://listmonk.app/docs/transactional">documentation</a>.
        </p>
    </div>

    <div class="footer" style="text-align: center;font-size: 12px;color: #888;">
        <p>{{ "public.poweredBy" | t }} <a href="https://listmonk.app" target="_blank" rel="noreferrer" style="color: #888;">listmonk</a></p>
    </div>
</body>
</html>
';
