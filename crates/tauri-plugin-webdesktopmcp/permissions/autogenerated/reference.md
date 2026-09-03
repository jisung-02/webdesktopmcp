## Default Permission

Default permissions for the webdesktopmcp plugin. Allows webview
pages to talk to the host bridge (`plugin:webdesktopmcp|send`); the bridge itself
enforces per-origin exposure rules from the wire protocol.

#### This default permission set includes the following:

- `allow-send`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`webdesktopmcp:allow-send`

</td>
<td>

Enables the send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`webdesktopmcp:deny-send`

</td>
<td>

Denies the send command without any pre-configured scope.

</td>
</tr>
</table>
