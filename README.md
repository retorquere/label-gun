# Manage issue feedback

## action.yml

```
name: 'Manage issues and nag about support logs'

on:
  issues:
    types: [opened, edited, closed]
  issue_comment:
    types: [created, edited, closed]

jobs:
  nag:
    runs-on: ubuntu-latest
    steps:
      - uses: retorquere/label-gun@master
        with:
          token: ${{ github.token }}
```

now with fully automatic nagging in honor of @element4l so that I can maintain some distance while people request my help but won't actually let me.
