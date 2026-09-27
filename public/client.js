const searchForm = document.querySelector('#searchForm')
const searchInput = document.querySelector('#search')
const results = document.querySelector('#results')

searchForm.addEventListener('submit', async event => {
    event.preventDefault()

    const search = searchInput.value

    try {
        results.textContent = 'Searching...'

        const response = await fetch(
            `/api/listings?q=${encodeURIComponent(search)}`
        )

        if (!response.ok) {
            throw new Error('Search request failed')
        }

        const listings = await response.json()

        results.replaceChildren()

        if (listings.length === 0) {
            results.textContent = 'No listings found.'
            return
        }

        for (const listing of listings) {
            const listingElement = document.createElement('article')

            const image = document.createElement('img')
            image.src = listing.image
            image.alt = listing.title
            image.width = 250

            const title = document.createElement('h2')
            title.textContent = listing.title

            const price = document.createElement('p')
            price.textContent = `Price: $${listing.price}`

            const shipping = document.createElement('p')
            shipping.textContent = `Shipping: $${listing.shipping}`

            const bids = document.createElement('p')
            bids.textContent = `Bids: ${listing.bids}`

            const link = document.createElement('a')
            link.href = listing.url
            link.textContent = 'View on eBay'
            link.target = '_blank'
            link.rel = 'noopener noreferrer'

            listingElement.append(image, title, price, shipping, bids, link)

            results.append(listingElement)
        }
    } catch (error) {
        console.error(error)
        results.textContent = 'Something went wrong while searching.'
    }
})
