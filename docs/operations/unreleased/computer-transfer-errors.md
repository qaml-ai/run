### Clearer computer transfer and file link errors

`computer_download` of a remote file that does not exist now answers 404, `<path> not found on the computer`. It used to
say the transfer exceeded the file size limit. `file_link` now accepts a generic `contentType`
(`application/octet-stream`, `application/x-www-form-urlencoded`, `multipart/form-data`) as saying nothing about the file,
instead of refusing it as invalid.
